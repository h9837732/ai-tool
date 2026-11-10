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
      res = await fetch(base + '/api/pair', {
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
    return { ok: true };
  }

  function disconnect() { saveConn(null); }

  async function info() {
    if (!isConnected()) return null;
    try {
      var res = await fetch(conn.url + '/api/info', { headers: headers() });
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
    if (!isConnected()) return { ok: false, error: 'notconnected' };
    if (busy) return { ok: false, error: 'busy' };
    busy = true;
    try {
      var payload = collectLocal();
      var res = await fetch(conn.url + '/api/sync', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      if (!res.ok) return { ok: false, error: await readError(res) };

      var merged = await res.json();
      var applied = applyMerged(merged);

      conn.lastSyncAt = Date.now();
      saveConn(conn);
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
      var res = await fetch(conn.url + '/api/files', { headers: headers() });
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
      var res = await fetch(conn.url + '/api/peers', { headers: headers() });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      var j = await res.json();
      return { ok: true, self: j.self, peers: (j && j.peers) || [] };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  global.Sync = {
    isConnected: isConnected,
    connection: connection,
    deviceName: deviceName,
    pair: pair,
    disconnect: disconnect,
    info: info,
    syncNow: syncNow,
    peers: peers,
    uploadFile: uploadFile,
    listFiles: listFiles,
    downloadFile: downloadFile,
    deleteFile: deleteFile,
    localPairCode: localPairCode
  };
})(window);
