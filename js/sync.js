/* 局域网同步客户端。
   电脑上跑 server/lan.mjs，手机连同一个 WiFi，用配对码换令牌后即可互相同步。

   刻意不同步的东西：API Key、模型选择、主题/语言等设备偏好。
   Key 是每台设备自己的秘密，跨设备复制只会扩大泄露面。 */
(function (global) {
  'use strict';

  var K_CONN = 'keyapp:sync';

  var conn = (function () {
    try {
      var raw = localStorage.getItem(K_CONN);
      var v = raw ? JSON.parse(raw) : null;
      if (v && v.url && v.token) return v;
    } catch (e) { /* 忽略 */ }
    return null;
  })();

  var busy = false;

  function saveConn(c) {
    conn = c;
    try {
      if (c) localStorage.setItem(K_CONN, JSON.stringify(c));
      else localStorage.removeItem(K_CONN);
    } catch (e) { /* 忽略 */ }
  }

  function isConnected() { return !!(conn && conn.url && conn.token); }
  function connection() { return conn; }

  function deviceName() {
    if (conn && conn.deviceName) return conn.deviceName;
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad/i.test(ua)) return 'iOS';
    return 'Browser';
  }

  function headers(extra) {
    var h = Object.assign({}, extra || {});
    if (conn && conn.token) h['authorization'] = 'Bearer ' + conn.token;
    return h;
  }

  /* ---------- 统一的请求入口 ----------

     为什么需要它：安卓 App 的页面来源是 https://localhost，
     向 http://192.168.x.x 发请求在 WebView 里属于混合内容，
     fetch 会直接失败（连 TCP 都不会发出去）。而局域网桥就是 http。
     所以 fetch 失败时必须改走原生 HTTP，否则手机永远连不上电脑。

     返回一个和 fetch 响应尽量一致的形状：{ ok, status, json(), text(), blob() }
     原生路径只能一次性拿到全文（不支持流式），够用。 */

  function nativeHttp() {
    return (global.Native && global.Native.NativeHttp && global.Native.NativeHttp.hasPlugin())
      ? global.Native.NativeHttp : null;
  }

  function fakeResponse(status, text) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      text: function () { return Promise.resolve(text); },
      json: function () {
        try { return Promise.resolve(JSON.parse(text || '{}')); }
        catch (e) { return Promise.resolve({}); }
      }
    };
  }

  /* 发请求。url 可以是相对路径（电脑端本机）或绝对地址（手机连电脑）。 */
  async function req(url, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var hdrs = opts.headers || {};
    var body = opts.body;

    var tries = 1;
    var lastErr = null;
    while (tries <= 2) {
      try {
        var res = await fetch(url, {
          method: method,
          headers: hdrs,
          body: body,
          cache: 'no-store'
        });
        return res;
      } catch (e) {
        lastErr = e;
        /* 第一次失败：如果是原生 App，改走原生 HTTP 再来一次 */
        if (tries === 1 && nativeHttp() && /^https?:\/\//i.test(url)) {
          tries++;
          var r = await nativeHttp().request(url, hdrs, method === 'GET' ? null : body, method);
          if (r) return fakeResponse(r.status, r.text);
          break;
        }
        break;
      }
    }
    throw lastErr || new Error('network');
  }

  /* 令牌失效（对端数据被清过、或换了电脑）时自动断开，
     否则界面只会显示 HTTP 401，用户不知道该干什么 */
  function authFail(res) {
    if (res.status === 401) {
      saveConn(null);
      return true;
    }
    return false;
  }

  async function readError(res) {
    var txt = await res.text().catch(function () { return ''; });
    try {
      var j = JSON.parse(txt);
      if (j && j.error) return j.error;
    } catch (e) { /* 非 JSON */ }
    return 'HTTP ' + res.status;
  }

  /* ---------- 配对 ---------- */

  async function pair(url, code, name) {
    var base = String(url || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'nourl' };

    var res;
    try {
      res = await req(base + '/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: String(code || '').trim(), deviceName: name || deviceName() })
      });
    } catch (e) {
      return { ok: false, error: 'network' };
    }
    if (!res.ok) return { ok: false, error: await readError(res) };

    var j = await res.json().catch(function () { return null; });
    if (!j || !j.token) return { ok: false, error: 'notoken' };

    saveConn({ url: base, token: j.token, deviceName: name || deviceName(), at: Date.now() });
    startEvents();
    return { ok: true };
  }

  function disconnect() { saveConn(null); }

  async function info() {
    if (!isConnected()) return null;
    try {
      var res = await req(conn.url + '/api/info', { headers: headers() });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  /* ---------- 同步 ---------- */

  /* 收集本机状态：对话、墓碑、技能 */
  function collectLocal() {
    var conversations = {};
    var index = Store.loadIndex();
    for (var i = 0; i < index.length; i++) {
      var c = Store.loadConv(index[i].id);
      if (c) conversations[c.id] = c;
    }
    return {
      conversations: conversations,
      tombstones: Store.loadTombstones(),
      skills: Store.loadSkills(),
      skillsAt: Store.loadSkillsAt()
    };
  }

  /* 把合并结果落回本机。返回 { pulled, pushed, deleted } */
  function applyMerged(merged) {
    var localIndex = Store.loadIndex();
    var byId = {};
    for (var i = 0; i < localIndex.length; i++) byId[localIndex[i].id] = localIndex[i];

    var pulled = 0;
    var deleted = 0;
    var convs = (merged && merged.conversations) || {};

    for (var id in convs) {
      if (!Object.prototype.hasOwnProperty.call(convs, id)) continue;
      var remote = convs[id];
      if (!remote || !remote.id) continue;

      var mine = Store.loadConv(id);
      if (!mine || (remote.updatedAt || 0) > (mine.updatedAt || 0)) {
        Store.saveConv(remote);
        byId[id] = {
          id: id,
          title: remote.title || 'Untitled',
          model: remote.model || '',
          updatedAt: remote.updatedAt || Date.now()
        };
        if (!mine) pulled++;
      }
    }

    /* 墓碑：本机有但服务端已删的，跟着删 */
    var tombs = (merged && merged.tombstones) || {};
    for (var tid in tombs) {
      if (!Object.prototype.hasOwnProperty.call(tombs, tid)) continue;
      var local = Store.loadConv(tid);
      if (local && (local.updatedAt || 0) <= tombs[tid]) {
        Store.removeConv(tid);
        delete byId[tid];
        deleted++;
      }
    }

    var list = Object.keys(byId).map(function (k) { return byId[k]; });
    list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    Store.saveIndex(list);

    if (merged && merged.skills && (merged.skillsAt || 0) > Store.loadSkillsAt()) {
      Store.saveSkills(merged.skills);
      Store.saveSkillsAt(merged.skillsAt || Date.now());
    }

    /* 把服务端的墓碑也存下来，避免自己的删除被旧数据复活 */
    for (var t2 in tombs) {
      if (Object.prototype.hasOwnProperty.call(tombs, t2)) Store.addTombstone(t2, tombs[t2], true);
    }

    var pushed = 0;
    for (var pid in convs) {
      if (!Object.prototype.hasOwnProperty.call(convs, pid)) continue;
      if (!localIndex.some(function (x) { return x.id === pid; })) pushed++;
    }

    return { pulled: pulled, deleted: deleted, total: list.length };
  }

  /* 跑一次双向同步 */
  async function syncNow() {
    /* 本页就是服务本机（电脑端）时，用相对路径直接读写同一份数据；
       手机端则是连到配对好的 conn.url。 */
    if (!hostMode) await detectHost();
    if (!isConnected() && !hostMode) return { ok: false, error: 'notconnected' };
    if (busy) return { ok: false, error: 'busy' };
    busy = true;
    try {
      var payload = collectLocal();
      payload.device = deviceName();
      var res = await req(apiBase() + '/api/sync', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      if (authFail(res)) return { ok: false, error: 'reauth' };
      if (!res.ok) return { ok: false, error: await readError(res) };

      var merged = await res.json();
      var applied = applyMerged(merged);

      if (conn) {
        conn.lastSyncAt = Date.now();
        saveConn(conn);
      }
      return { ok: true, result: applied, serverTime: merged.serverTime };
    } catch (e) {
      return { ok: false, error: 'network' };
    } finally {
      busy = false;
    }
  }

  /* ---------- 文件 ---------- */

  async function uploadFile(name, blob) {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await fetch(conn.url + '/api/files', {
        method: 'POST',
        headers: headers({
          'content-type': 'application/octet-stream',
          'x-filename': encodeURIComponent(name || 'file')
        }),
        body: blob
      });
      if (!res.ok) return { ok: false, error: await readError(res) };
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  async function listFiles() {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await req(conn.url + '/api/files', { headers: headers() });
      if (authFail(res)) return { ok: false, error: 'reauth' };
      if (!res.ok) return { ok: false, error: await readError(res) };
      var j = await res.json();
      return { ok: true, files: (j && j.files) || [] };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  async function downloadFile(name) {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await fetch(conn.url + '/api/files/' + encodeURIComponent(name), { headers: headers() });
      if (!res.ok) return { ok: false, error: await readError(res) };
      return { ok: true, blob: await res.blob() };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  async function deleteFile(name) {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await fetch(conn.url + '/api/files/' + encodeURIComponent(name), {
        method: 'DELETE',
        headers: headers()
      });
      return { ok: res.ok };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  /* 从服务端把配对码读到吗？只有电脑本机可以——用来在电脑浏览器上自动填 */
  async function localPairCode() {
    try {
      var res = await fetch('/api/code');
      if (!res.ok) return null;
      var j = await res.json();
      return j && j.code ? j.code : null;
    } catch (e) {
      return null;
    }
  }


  /* ---------- 自动发现（照 LocalSend 的思路） ----------
     浏览器不能加入 UDP 组播，所以发现是「问服务端要它听见的邻居」：
     电脑上的桥服务在组播组里广播，手机连上任意一台后就能看到其他电脑。
     另外提供「手动扫一扫」：让桥服务立刻再广播一次。 */

  async function peers() {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await req(conn.url + '/api/peers', { headers: headers() });
      if (authFail(res)) return { ok: false, error: 'reauth' };
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      var j = await res.json();
      return { ok: true, self: j.self, peers: (j && j.peers) || [] };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }


  /* ---------- 电脑端：已配对的手机 ---------- */

  async function devices() {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await req(conn.url + '/api/devices', { headers: headers() });
      if (authFail(res)) return { ok: false, error: 'reauth' };
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      var j = await res.json();
      return { ok: true, devices: (j && j.devices) || [] };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  async function kickDevice(tail) {
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    try {
      var res = await req(conn.url + '/api/devices', {
        method: 'DELETE',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tail: tail })
      });
      if (authFail(res)) return { ok: false, error: 'reauth' };
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  /* ---------- 实时同步 ----------

     做法：中枢（电脑端服务）维持 SSE 长连接。任一端改了东西就
     ① POST /api/touch 让中枢广播  ② 中枢合并后再广播一次
     其他端收到 changed → 防抖 700ms → 跑一次 syncNow。

     为什么不再轮询：以前只有「启动时 + 手点」，改了对话另一头看不见。 */

  var es = null;
  var esUrl = '';
  var changeCb = null;
  var touchTimer = null;
  var syncTimer = null;
  var hostMode = null;          // null=未知，true=本页就是这个服务（电脑端）

  /* 当前页面是不是「服务本机」——电脑端就是这样：页面由 8787 自己托管。
     这种情况不需要令牌，也不需要 conn。 */
  function detectHost() {
    if (hostMode !== null) return Promise.resolve(hostMode);
    return fetch('/api/ping', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { hostMode = !!(j && j.app === 'keyapp'); return hostMode; })
      .catch(function () { hostMode = false; return false; });
  }

  function eventsUrl() {
    if (isConnected()) return conn.url + '/api/events?token=' + encodeURIComponent(conn.token || '');
    if (hostMode) return '/api/events';
    return '';
  }

  function apiBase() {
    return isConnected() ? conn.url : '';
  }

  function dispatchChanged(info) {
    if (typeof changeCb === 'function') {
      try { changeCb(info || {}); } catch (e) { /* 忽略 */ }
    }
  }

  function scheduleSync(info) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      syncTimer = null;
      syncNow().then(function (r) {
        if (r && r.ok) {
          dispatchChanged({ pulled: r.result && r.result.pulled, deleted: r.result && r.result.deleted });
        } else if (r && r.error === 'busy') {
          scheduleSync(info);          // 自己正在同步，稍后再来一趟
        }
      }).catch(function () {});
    }, 700);
  }

  function startEvents() {
    if (typeof EventSource === 'undefined') return;
    detectHost().then(function () {
      var url = eventsUrl();
      if (!url) { stopEvents(); return; }
      if (es && esUrl === url) return;
      stopEvents();
      try {
        es = new EventSource(url);
        esUrl = url;
        es.addEventListener('changed', function (ev) {
          var data = {};
          try { data = JSON.parse(ev.data || '{}'); } catch (e) { /* 忽略 */ }
          /* 服务端已按令牌排除发起方，这里不用再判自己 */
          scheduleSync(data);
        });
        es.onerror = function () {
          if (!isConnected() && !hostMode) { stopEvents(); return; }
          /* 连不上或断了：EventSource 会自己重连，但同时开轮询兜底，
             这样安卓上（混合内容把 SSE 拦了）也不会完全没有实时性 */
          startPolling();
        };
        es.onopen = function () { stopPolling(); };
      } catch (e) {
        es = null;
        esUrl = '';
      }
    });
  }

  function stopEvents() {
    if (es) {
      try { es.close(); } catch (e) { /* 忽略 */ }
    }
    es = null;
    esUrl = '';
    stopPolling();
  }

  /* ---------- 轮询兜底 ----------

     安卓 App 里 EventSource 建不起来：页面是 https://localhost，
     SSE 要连 http://192.168.x.x，被当成混合内容拦掉（原生 HTTP 也
     不支持流式）。没有它就不实时了，所以退成定时拉取。
     电脑端是 http 同源页面，SSE 正常，不会走到这里。 */

  var pollTimer = null;
  var POLL_MS = 20000;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;   // 后台不拉
      if (!isConnected() && !hostMode) return;
      syncNow().then(function (r) {
        if (r && r.ok) {
          dispatchChanged({ pulled: r.result && r.result.pulled,
                            deleted: r.result && r.result.deleted });
        }
      }).catch(function () {});
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* 本地改了数据 → 告诉中枢「我变了」，让别的端来拉。
     没配对时什么都不做（单机用不需要）。 */
  function touch(immediate) {
    function fire() {
      touchTimer = null;
      var base = apiBase();
      req(base + '/api/touch', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ device: deviceName() })
      }).catch(function () {});
    }
    if (!isConnected() && !hostMode) return;
    if (immediate) {
      if (touchTimer) clearTimeout(touchTimer);
      fire();
      return;
    }
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = setTimeout(fire, 500);
  }

  /* 把 Store 的写操作接上钩子，业务代码一处不用改 */
  var hooked = false;
  function hookStore() {
    if (hooked || !global.Store) return;
    hooked = true;
    ['saveConv', 'removeConv', 'saveSkills'].forEach(function (fn) {
      var orig = global.Store[fn];
      if (typeof orig !== 'function') return;
      global.Store[fn] = function () {
        var r = orig.apply(global.Store, arguments);
        try { touch(false); } catch (e) { /* 忽略 */ }
        return r;
      };
    });
  }

  /* 订阅回调：另一台设备改了东西 */
  function onChanged(cb) {
    changeCb = cb;
    hookStore();
    startEvents();
    /* EventSource 不可用（老的 WebView / 被禁用）→ 直接上轮询 */
    if (typeof EventSource === 'undefined') startPolling();
  }

  function stopEvents2() { stopEvents(); }

  /* ---------- 免认证探测：扫描局域网用 ---------- */

  /* 打一台机器的 /api/ping，超时很短。命中返回设备信息，否则 null。 */
  function probe(ip, port, timeoutMs) {
    port = port || 8787;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 700);
    return fetch('http://' + ip + ':' + port + '/api/ping', {
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store'
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) return null;
      return res.json().then(function (j) {
        return j && j.app === 'keyapp' ? { ip: ip, port: port, alias: j.alias || ip, url: j.url || ('http://' + ip + ':' + port) } : null;
      });
    }).catch(function () {
      clearTimeout(timer);
      return null;
    });
  }

  /* 扫描一批网段的 1-254。
     App 里必须走原生（混合内容禁令），浏览器里退回 fetch 探测。 */
  function expandTargets(prefixes) {
    var targets = [];
    for (var i = 0; i < prefixes.length; i++) {
      var pre = String(prefixes[i]).replace(/\.$/, '');
      if (!pre) continue;
      for (var n = 1; n <= 254; n++) targets.push(pre + '.' + n);
    }
    return targets;
  }

  async function scanLan(opts) {
    opts = opts || {};
    var prefixes = opts.prefixes || [];
    var port = opts.port || 8787;
    var concurrency = opts.concurrency || 64;
    var timeoutMs = opts.timeoutMs || 400;
    var onProgress = opts.onProgress || function () {};
    var targets = expandTargets(prefixes);
    if (!targets.length) return [];

    /* 原生扫描：一个 /24 一组地跑，每组回来就报进度 */
    if (global.Native && global.Native.NetInfo && global.Native.NetInfo.hasPlugin()) {
      var found = [];
      var done = 0;
      var CHUNK = 128;
      for (var start = 0; start < targets.length; start += CHUNK) {
        var slice = targets.slice(start, start + CHUNK);
        var hits = await global.Native.NetInfo.scan(slice, {
          port: port, timeoutMs: timeoutMs, concurrency: concurrency
        });
        if (hits === null) break;          // 插件不可用，掉到下面的 fetch 路径
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (!found.some(function (f) { return f.ip === hit.ip; })) found.push(hit);
        }
        done += slice.length;
        onProgress(done, targets.length, found);
      }
      if (done >= targets.length) return found;
    }

    /* 浏览器路径：断端口探，靠超时判活 */
    var found2 = [];
    var idx = 0;
    var done2 = 0;

    async function worker() {
      while (idx < targets.length) {
        var ip = targets[idx++];
        var hit = await probe(ip, port, timeoutMs);
        done2++;
        if (hit) {
          if (!found2.some(function (f) { return f.ip === hit.ip; })) found2.push(hit);
          onProgress(done2, targets.length, found2);
        } else if (done2 % 24 === 0) {
          onProgress(done2, targets.length, found2);
        }
      }
    }

    var workers = [];
    for (var w = 0; w < Math.min(concurrency, targets.length); w++) workers.push(worker());
    await Promise.all(workers);
    onProgress(done2, targets.length, found2);
    return found2;
  }

  function prefixOf(ip) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return '';
    if (/^(127\.|0\.|169\.254\.)/.test(ip)) return '';
    return ip.split('.').slice(0, 3).join('.');
  }

  /* 推断可能所在的网段。顺序就是可信度：
       页面地址 > 已配对电脑 > 本机 IPv4（原生） */
  async function lanPrefixes() {
    var out = [];
    function add(p) {
      if (p && out.indexOf(p) < 0) out.push(p);
    }

    add(prefixOf(location.hostname));

    if (conn && conn.url) {
      var m = /\/\/(\d+\.\d+\.\d+\.\d+)/.exec(conn.url);
      if (m) add(prefixOf(m[1]));
    }

    try {
      if (global.Native && global.Native.NetInfo && global.Native.NetInfo.hasPlugin()) {
        var ips = await global.Native.NetInfo.localIps();
        for (var i = 0; i < ips.length; i++) add(prefixOf(ips[i]));
      }
    } catch (e) { /* 拿不到就算了 */ }

    return out;
  }

  /* 常见家用网段。自己网段扫不到时的兵底，从 LocalSend 的经典清单抬的。 */
  var COMMON_PREFIXES = ['192.168.1', '192.168.0', '192.168.2', '192.168.31',
    '192.168.3', '192.168.4', '192.168.10', '192.168.100', '10.0.0', '10.0.1',
    '172.16.0', '192.168.123',
    /* 手机热点：安卓常见 192.168.43 / 42 / 137，iPhone 是 172.20.10 */
    '192.168.43', '192.168.42', '192.168.137', '172.20.10'];

  global.Sync = {
    isConnected: isConnected,
    connection: connection,
    deviceName: deviceName,
    pair: pair,
    disconnect: function () { stopEvents(); disconnect(); },
    info: info,
    syncNow: syncNow,
    onChanged: onChanged,
    touch: touch,
    startEvents: startEvents,
    stopEvents: stopEvents,
    peers: peers,
    uploadFile: uploadFile,
    listFiles: listFiles,
    downloadFile: downloadFile,
    deleteFile: deleteFile,
    localPairCode: localPairCode,
    probe: probe,
    scanLan: scanLan,
    lanPrefixes: lanPrefixes,
    COMMON_PREFIXES: COMMON_PREFIXES,
    devices: devices,
    kickDevice: kickDevice
  };
})(window);
