/* 原生能力封装：加密存储 + 原生 HTTP。
   打包后的 App 用 Capacitor 插件；电脑端（pywebview）用 Windows DPAPI；
   纯浏览器里两者都没有，自动退回 localStorage / fetch。
   所有函数都不会抛异常，失败一律返回可判断的结果。 */
(function (global) {
  'use strict';

  var capacitor = !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());

  /* 电脑端的桥（pywebview 注入）。它可能比本文件晚出现，所以用函数探测。 */
  function desktopApi() {
    return (global.pywebview && global.pywebview.api) ? global.pywebview.api : null;
  }

  var native = capacitor;

  /* 取插件：优先 Capacitor.registerPlugin（本地注册的插件也能拿到），
     再退回 Capacitor.Plugins（由 cap sync 生成的清单里的插件）。 */
  function plugin(name) {
    if (!capacitor || !global.Capacitor) return null;
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

  /* 电脑端的 SecureStore 适配器：把 DPAPI 桥包成和 Capacitor 插件一样的形状，
     这样 store.js 完全不用区分平台。 */
  function desktopSecureStore() {
    var api = desktopApi();
    if (!api || typeof api.secure_get !== 'function') return null;
    return {
      isDesktop: true,
      /* 必须有 {available} 这层：check() 读的是 r.available，
         直接返布尔值会被当成 undefined → 永远认为不可用 */
      isAvailable: function () {
        return Promise.resolve({ available: !!api.secure_available() });
      },
      get: function (opts) {
        return Promise.resolve(api.secure_get(opts && opts.key)).then(function (v) {
          return { value: v };
        });
      },
      set: function (opts) {
        return Promise.resolve(api.secure_set(opts.key, opts.value)).then(function (ok) {
          if (!ok) throw new Error('set failed');
          return { ok: true };
        });
      },
      remove: function (opts) {
        return Promise.resolve(api.secure_remove(opts && opts.key));
      }
    };
  }

  /* ---------- 加密存储 ---------- */

  var SecureStore = (function () {
    var available = false;
    var checked = false;
    var dsk = null;

    /* 电脑端的桥是页面加载完才注入的（window.pywebview 晚一步出现），
       所以必须惰性探测。以前在 IIFE 执行时就算了一次，那时桥还不存在，
       结果 isNative 永远是 false，密钥一直走明文。 */
    function impl() {
      var c = plugin('SecureStore');
      if (c) return c;
      if (!dsk) dsk = desktopSecureStore();
      return dsk;
    }

    function check() {
      if (checked) return Promise.resolve(available);
      var s = impl();
      if (!s) {
        /* 还没桥：不缓存结果，下次调用再试 */
        return Promise.resolve(false);
      }
      checked = true;
      return Promise.resolve(s.isAvailable())
        .then(function (r) {
          available = !!(r && (r.available === true || r.value === true));
          return available;
        })
        .catch(function () { available = false; return false; });
    }

    function pick(key) {
      var s = impl();
      if (!s || !available) return null;
      return s;
    }

    return {
      /* 用 getter，每次读都是新值（桥可能是刚刚才注入的） */
      get isNative() { return capacitor || !!impl(); },
      get isDesktop() { return !capacitor && !!impl(); },
      check: check,
      isAvailable: function () { return available; },
      get: function (key) {
        var s = pick(key);
        if (!s) return Promise.resolve(null);
        return Promise.resolve(s.get({ key: key }))
          .then(function (r) { return r && typeof r.value === 'string' ? r.value : null; })
          .catch(function () { return null; });
      },
      set: function (key, value) {
        var s = pick(key);
        if (!s) return Promise.resolve(false);
        return Promise.resolve(s.set({ key: key, value: String(value) }))
          .then(function () { return true; })
          .catch(function () { return false; });
      },
      remove: function (key) {
        var s = pick(key);
        if (!s) return Promise.resolve(false);
        return Promise.resolve(s.remove({ key: key }))
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
      /* bodyObj 可以直接给字符串（局域网桥用 JSON 字符串），
         method 可选，默认 POST。
         注意：原生路径不支持流式，也不该拿来给服务商发对话（会丢掉逐字输出）。 */
      request: function (url, headers, bodyObj, method) {
        if (!http) return Promise.resolve(null);
        var body = (typeof bodyObj === 'string') ? bodyObj
          : (bodyObj == null ? '' : JSON.stringify(bodyObj));
        return Promise.resolve(http.request({
          url: url,
          method: (method || 'POST').toUpperCase(),
          headers: headers || {},
          body: body
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
      install: function (url, sha256) {
        if (!up) return Promise.resolve({ ok: false, error: 'noplugin' });
        return Promise.resolve(up.install({ url: url, sha256: sha256 || '' }))
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
