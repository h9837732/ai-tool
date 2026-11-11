/* 版本更新检查。
   两条数据源，按顺序尝试：
     1. 自定义 JSON（localStorage 里 keyapp:updateUrl 指向的地址，格式见下）
     2. GitHub Releases API（仓库公开时可直接用，私有仓库匿名访问会 404）

   自定义 JSON 格式：
     { "version": "1.2.0", "url": "https://.../keyapp-1.2.0.apk", "notes": "可选" }

   这个模块只负责“查”和“比”，弹出界面由 app.js 处理。 */
(function (global) {
  'use strict';

  /* 想换仓库只改这两行 */
  var REPO_OWNER = 'h9837732';
  var REPO_NAME = 'ai-tool';

  var K_URL = 'keyapp:updateUrl';
  var K_AT = 'keyapp:updateCheckedAt';
  var K_SKIP = 'keyapp:updateSkipped';
  var MIN_INTERVAL = 6 * 60 * 60 * 1000;   // 自动检查最少间隔 6 小时

  function current() {
    return String(global.APP_VERSION || '1.1.0');
  }

  /* 去掉 v 前缀，按数字段比较。返回 1 / 0 / -1 */
  function compare(a, b) {
    function parts(v) {
      return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map(function (x) {
        var n = parseInt(x, 10);
        return isNaN(n) ? 0 : n;
      });
    }
    var pa = parts(a);
    var pb = parts(b);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  function customEndpoint() {
    try { return localStorage.getItem(K_URL) || ''; } catch (e) { return ''; }
  }

  function readAt() {
    try { return Number(localStorage.getItem(K_AT) || 0) || 0; } catch (e) { return 0; }
  }

  function writeAt(ts) {
    try { localStorage.setItem(K_AT, String(ts)); } catch (e) { /* 忽略 */ }
  }

  function skippedVersion() {
    try { return localStorage.getItem(K_SKIP) || ''; } catch (e) { return ''; }
  }

  function skip(version) {
    try { localStorage.setItem(K_SKIP, String(version || '')); } catch (e) { /* 忽略 */ }
  }

  function platform() {
    if (global.pywebview && global.pywebview.api && global.pywebview.api.self_update) return 'desktop';
    if (global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()) return 'android';
    return 'web';
  }

  /* 从 release 的 asset 列表里挑适合当前平台的那个。
     一个 release 会同时挂 钥匙.exe 和 keyapp.apk，
     以前直接取 assets[0]，电脑端会下到 APK。 */
  function pickAsset(assets) {
    var list = assets || [];
    var want = platform() === 'android' ? /\.apk$/i : /\.(exe|msi|zip)$/i;
    for (var i = 0; i < list.length; i++) {
      var n = String((list[i] && list[i].name) || '');
      if (want.test(n) && list[i].browser_download_url) return list[i];
    }
    /* 没对上就取第一个：至少还能手动下 */
    return list[0] || {};
  }

  function parseGithub(j) {
    if (!j || !j.tag_name) return null;
    var asset = pickAsset(j.assets);
    return {
      version: String(j.tag_name).replace(/^v/i, ''),
      url: asset.browser_download_url || j.html_url || '',
      notes: String(j.body || '').slice(0, 500)
    };
  }

  function parseCustom(j) {
    if (!j || !j.version) return null;
    return {
      version: String(j.version).replace(/^v/i, ''),
      url: String(j.url || ''),
      notes: String(j.notes || '')
    };
  }

  function getJSON(url) {
    return fetch(url, { headers: { 'accept': 'application/json' } }).then(function (r) {
      if (!r.ok) {
        var e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r.json();
    });
  }

  var checking = null;

  /* 返回 Promise<{status, latest, url, notes, error, source}> */
  function check(opts) {
    opts = opts || {};
    if (checking) return checking;

    var custom = customEndpoint();

    if (!opts.force && !custom) {
      var at = readAt();
      if (at && Date.now() - at < MIN_INTERVAL) {
        return Promise.resolve({ status: 'skipped', reason: 'throttled', current: current() });
      }
    }

    var ghUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/latest';

    checking = (custom
      ? getJSON(custom).then(function (j) { return { data: parseCustom(j), source: 'custom' }; })
      : getJSON(ghUrl).then(function (j) { return { data: parseGithub(j), source: 'github' }; })
    ).then(function (res) {
      writeAt(Date.now());
      if (!res.data) return { status: 'error', error: 'empty', current: current(), source: res.source };
      var latest = res.data.version;
      var cmp = compare(latest, current());
      return {
        status: cmp > 0 ? 'newer' : 'latest',
        latest: latest,
        url: res.data.url,
        notes: res.data.notes || '',
        current: current(),
        source: res.source
      };
    }).catch(function (err) {
      writeAt(Date.now());
      return {
        status: 'error',
        error: (err && err.message) || 'failed',
        httpStatus: err && err.status,
        current: current(),
        source: custom ? 'custom' : 'github'
      };
    }).then(function (r) {
      checking = null;
      return r;
    });

    return checking;
  }

  /* 打开外部链接：先用 Capacitor 的 _system 目标交给系统浏览器，再退回普通跳转 */
  function open(url) {
    if (!url) return;
    var isNative = !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());
    if (isNative) {
      try {
        var w = global.open(url, '_system');
        if (w) return;
      } catch (e) { /* 退回下面的方式 */ }
    }
    try {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      global.location.href = url;
    }
  }

  /* 就地在应用内更新。返回 Promise<{ok, mode, error}> */
  function install(url) {
    if (!url) return Promise.resolve({ ok: false, error: 'nourl' });
    var p = platform();

    /* 电脑端：交给 Python 下载并替换 exe，进程会重启 */
    if (p === 'desktop') {
      return Promise.resolve(global.pywebview.api.self_update(url))
        .then(function (r) {
          if (r && r.ok) return { ok: true, mode: 'desktop' };
          if (r && r.error === 'dev-mode') return { ok: false, error: 'dev-mode' };
          return { ok: false, error: (r && r.error) || 'failed' };
        })
        .catch(function (e) { return { ok: false, error: (e && e.message) || 'failed' }; });
    }

    /* 手机端：原生下载 APK 再弹系统安装 */
    if (p === 'android' && global.Native && global.Native.ApkUpdater && global.Native.ApkUpdater.hasPlugin()) {
      return Promise.resolve(global.Native.ApkUpdater.install(url))
        .then(function (r) {
          if (r && r.ok) return { ok: true, mode: 'android' };
          return { ok: false, error: (r && r.error) || 'failed' };
        })
        .catch(function (e) { return { ok: false, error: (e && e.message) || 'failed' }; });
    }

    /* 其余（浏览器网页版）：只能开下载页 */
    open(url);
    return Promise.resolve({ ok: false, mode: 'manual', error: 'manual' });
  }

  global.Update = {
    current: current,
    compare: compare,
    check: check,
    open: open,
    install: install,
    platform: platform,
    skip: skip,
    skippedVersion: skippedVersion,
    customEndpoint: customEndpoint,
    setCustomEndpoint: function (u) {
      try {
        if (u) localStorage.setItem(K_URL, String(u));
        else localStorage.removeItem(K_URL);
        localStorage.removeItem(K_AT);
      } catch (e) { /* 忽略 */ }
    },
    repoUrl: 'https://github.com/' + REPO_OWNER + '/' + REPO_NAME
  };
})(window);
