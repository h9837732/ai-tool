/* 原生能力封装：加密存储 + 原生 HTTP。
   在打包后的 App 里用 Capacitor 插件；在浏览器里自动退回 localStorage / fetch，
   所有函数都不会抛异常，失败一律返回可判断的结果。 */
(function (global) {
  'use strict';

  var native = !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());

  /* 取插件：优先 Capacitor.registerPlugin（本地注册的插件也能拿到），
     再退回 Capacitor.Plugins（由 cap sync 生成的清单里的插件）。 */
  function plugin(name) {
    if (!native || !global.Capacitor) return null;
    var C = global.Capacitor;
    if (typeof C.registerPlugin === 'function') {
      try {
        var p = C.registerPlugin(name);
        if (p) return p;
      } catch (e) { /* 继续尝试下一种 */ }
    }
    if (C.Plugins && C.Plugins[name]) return C.Plugins[name];
    return null;
  }

  /* ---------- 加密存储 ---------- */

  var SecureStore = (function () {
    var store = plugin('SecureStore');
    var available = false;
    var checked = false;

    function check() {
      if (checked) return Promise.resolve(available);
      checked = true;
      if (!store) { available = false; return Promise.resolve(false); }
      return Promise.resolve(store.isAvailable())
        .then(function (r) {
          available = !!(r && (r.available === true || r.value === true));
          return available;
        })
        .catch(function () { available = false; return false; });
    }

    return {
      isNative: native,
      check: check,
      isAvailable: function () { return available; },
      get: function (key) {
        if (!store || !available) return Promise.resolve(null);
        return Promise.resolve(store.get({ key: key }))
          .then(function (r) { return r && typeof r.value === 'string' ? r.value : null; })
          .catch(function () { return null; });
      },
      set: function (key, value) {
        if (!store || !available) return Promise.resolve(false);
        return Promise.resolve(store.set({ key: key, value: String(value) }))
          .then(function () { return true; })
          .catch(function () { return false; });
      },
      remove: function (key) {
        if (!store || !available) return Promise.resolve(false);
        return Promise.resolve(store.remove({ key: key }))
          .then(function () { return true; })
          .catch(function () { return false; });
      }
    };
  })();

  /* ---------- 原生 HTTP（绕开浏览器跨域） ---------- */

  var NativeHttp = (function () {
    var http = plugin('NativeHttp');

    return {
      isNative: native,
      hasPlugin: function () { return !!http; },
      /* 返回 { ok, status, text } 或 null（不可用/失败） */
      request: function (url, headers, bodyObj) {
        if (!http) return Promise.resolve(null);
        return Promise.resolve(http.request({
          url: url,
          method: 'POST',
          headers: headers || {},
          body: JSON.stringify(bodyObj || {})
        })).then(function (r) {
          if (!r) return null;
          var status = Number(r.status) || 0;
          var text = typeof r.body === 'string' ? r.body : (r.body == null ? '' : String(r.body));
          return { ok: status >= 200 && status < 300, status: status, text: text };
        }).catch(function () { return null; });
      }
    };
  })();

  /* ---------- 局域网探测（原生） ----------
     扫描必须走原生：App 的 origin 是 https://localhost，
     从它 fetch http://192.168.x.x 是混合内容，WebView 会拦掉。 */

  var NetInfo = (function () {
    var net = plugin('NetInfo');

    return {
      isNative: native,
      hasPlugin: function () { return !!net; },

      /* 本机所有 IPv4。取不到返回 []（调用方会退回常见网段） */
      localIps: function () {
        if (!net) return Promise.resolve([]);
        return Promise.resolve(net.localIps())
          .then(function (r) { return (r && r.ips) || []; })
          .catch(function () { return []; });
      },

      /* 扫一批 ip，返回 [{ip, port, alias, url}]。无插件时返回 null */
      scan: function (ips, opts) {
        if (!net) return Promise.resolve(null);
        opts = opts || {};
        return Promise.resolve(net.scan({
          ips: ips || [],
          port: opts.port || 8787,
          timeoutMs: opts.timeoutMs || 400,
          concurrency: opts.concurrency || 64
        })).then(function (r) {
          return (r && r.found) || [];
        }).catch(function () { return null; });
      }
    };
  })();

  /* ---------- 应用内更新（原生） ----------
     WebView 下不了 apk、也装不了，必须走原生：
     下载到 cache/updates → FileProvider 发个 content:// → 拉起系统安装器。 */

  var ApkUpdater = (function () {
    var up = plugin('ApkUpdater');

    return {
      isNative: native,
      hasPlugin: function () { return !!up; },
      info: function () {
        if (!up) return Promise.resolve(null);
        return Promise.resolve(up.info()).catch(function () { return null; });
      },
      install: function (url) {
        if (!up) return Promise.resolve({ ok: false, error: 'noplugin' });
        return Promise.resolve(up.install({ url: url }))
          .then(function (r) {
            if (!r) return { ok: false, error: 'failed' };
            return { ok: !!r.ok, error: r.error || '' };
          })
          .catch(function (e) { return { ok: false, error: (e && e.message) || 'failed' }; });
      }
    };
  })();

  global.Native = {
    isNative: native,
    SecureStore: SecureStore,
    NativeHttp: NativeHttp,
    NetInfo: NetInfo,
    ApkUpdater: ApkUpdater
  };
})(window);
