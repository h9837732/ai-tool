/* 本机存储层。
   优先 localStorage；浏览器禁用持久化（例如直接 file:// 打开时的隐私限制）时
   退回内存存储，并在界面上提示用户导出备份。所有数据都留在本机。

   密钥条目（profiles）在打包成 App 后会额外走一遍系统钥匙串加密：
   加密版本存 secure vault，明文副本从 localStorage 里删掉。
   任何一步失败都保留明文副本，绝不丢数据。 */

const Store = (function () {
  const PREFIX = 'keyapp:';
  const K_INDEX = PREFIX + 'index';
  const K_CONV = PREFIX + 'conv:';
  const K_SETTINGS = PREFIX + 'settings';
  const K_PROFILES = PREFIX + 'profiles';
  const K_ACTIVE = PREFIX + 'activeProfile';
  const K_SKILLS = PREFIX + 'skills';
  const K_SCHEMA = PREFIX + 'schemaVersion';
  const K_SECURE = PREFIX + 'secureProfiles';

  /* 当前数据结构版本。加字段不用动它，只有改了存储形态才 +1。 */
  const SCHEMA = 2;

  const memory = new Map();
  let persistent = false;

  try {
    const probe = PREFIX + 'probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    persistent = true;
  } catch (e) {
    persistent = false;
  }

  function readRaw(key) {
    if (!persistent) return memory.has(key) ? memory.get(key) : null;
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeRaw(key, value) {
    if (!persistent) { memory.set(key, value); return true; }
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function removeRaw(key) {
    if (!persistent) { memory.delete(key); return; }
    try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  function readJSON(key, fallback) {
    const raw = readRaw(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function readArray(key) {
    const v = readJSON(key, []);
    return Array.isArray(v) ? v : [];
  }

  let secureReady = false;

  return {
    isPersistent: function () { return persistent; },
    usesSecureProfiles: function () { return secureReady; },
    schemaVersion: function () {
      const v = Number(readRaw(K_SCHEMA) || 0);
      return isNaN(v) ? 0 : v;
    },
    setSchemaVersion: function (v) { return writeRaw(K_SCHEMA, String(v)); },
    targetSchema: SCHEMA,

    loadSettings: function () { return readJSON(K_SETTINGS, null); },
    saveSettings: function (obj) { return writeRaw(K_SETTINGS, JSON.stringify(obj)); },

    /* ---- 密钥条目 ---- */
    /* 同步读取：优先加密副本的本地缓存；没有就退回明文。 */
    loadProfiles: function () {
      const secured = readRaw(K_SECURE);
      if (secured) {
        try {
          const arr = JSON.parse(secured);
          if (Array.isArray(arr)) return arr;
        } catch (e) { /* 落到明文 */ }
      }
      return readArray(K_PROFILES);
    },

    /* 异步保存：App 里走钥匙串，浏览器里就是 localStorage。
       返回 Promise<{ ok, secure }>。 */
    saveProfiles: async function (list) {
      const json = JSON.stringify(list);
      const plainOk = writeRaw(K_PROFILES, json);

      const S = (typeof Native !== 'undefined') ? Native.SecureStore : null;
      if (S && S.isNative) {
        const avail = await S.check();
        if (avail) {
          const ok = await S.set('profiles', json);
          if (ok) {
            secureReady = true;
            writeRaw(K_SECURE, json);   // 本地缓存，供下次同步读取
            return { ok: true, secure: true };
          }
        }
      }
      return { ok: plainOk, secure: false };
    },

    loadActiveProfile: function () { return readRaw(K_ACTIVE) || ''; },
    saveActiveProfile: function (id) { return writeRaw(K_ACTIVE, id); },

    /* ---- 技能 ---- */
    loadSkills: function () { return readArray(K_SKILLS); },
    saveSkills: function (list) { return writeRaw(K_SKILLS, JSON.stringify(list)); },

    /* ---- 对话 ---- */
    loadIndex: function () { return readArray(K_INDEX); },
    saveIndex: function (list) { return writeRaw(K_INDEX, JSON.stringify(list)); },

    loadConv: function (id) { return readJSON(K_CONV + id, null); },
    saveConv: function (conv) { return writeRaw(K_CONV + conv.id, JSON.stringify(conv)); },
    removeConv: function (id) { removeRaw(K_CONV + id); },

    /* ---- 升级迁移 ----
       只读不动、只补不删：老版本的键原样保留，新版本加自己的版本号。
       唯一会删的是「加密成功后」的明文密钥副本。返回做了什么，供界面提示。 */
    migrate: async function () {
      const from = Number(readRaw(K_SCHEMA) || 0);
      const done = [];

      /* v0/v1：单条全局 Key → 密钥条目列表（老版本留下的 apiKey 字段） */
      if (from < 1) {
        const s = readJSON(K_SETTINGS, null) || {};
        const profiles = readArray(K_PROFILES);
        if (!profiles.length && s.apiKey) {
          const list = [{
            id: 'migrated-' + Date.now().toString(36),
            label: s.providerId || 'default',
            providerId: s.providerId || 'deepseek',
            baseUrl: s.baseUrl || '',
            apiKey: s.apiKey,
            model: s.model || ''
          }];
          writeRaw(K_PROFILES, JSON.stringify(list));
          writeRaw(K_ACTIVE, list[0].id);
          done.push('legacy-key');
        }
      }

      /* v2：密钥挪进系统钥匙串加密 */
      if (from < 2) {
        const S = (typeof Native !== 'undefined') ? Native.SecureStore : null;
        const plain = readArray(K_PROFILES);
        if (S && S.isNative && plain.length) {
          const avail = await S.check();
          if (avail) {
            const ok = await S.set('profiles', JSON.stringify(plain));
            if (ok) {
              secureReady = true;
              writeRaw(K_SECURE, JSON.stringify(plain));
              removeRaw(K_PROFILES);       // 明文副本已经不必要
              done.push('encrypted-keys');
            }
          }
        }
      }

      writeRaw(K_SCHEMA, String(SCHEMA));
      return { from: from, to: SCHEMA, done: done };
    },

    dumpAll: function () {
      const index = this.loadIndex();
      const convs = [];
      for (let i = 0; i < index.length; i++) {
        const c = this.loadConv(index[i].id);
        if (c) convs.push(c);
      }
      return {
        format: 'keyapp-backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        conversations: convs
      };
    },

    /* 只导入对话，不导入密钥（密钥跟着设备走，避免一份备份泄漏所有 Key） */
    importAll: function (payload) {
      const list = (payload && payload.conversations) || [];
      const index = this.loadIndex();
      const have = new Set(index.map(x => x.id));
      let added = 0;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || !c.id || have.has(c.id)) continue;
        if (!this.saveConv(c)) break;
        index.unshift({
          id: c.id,
          title: c.title || '未命名对话',
          model: c.model || '',
          updatedAt: c.updatedAt || Date.now()
        });
        have.add(c.id);
        added++;
      }
      index.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this.saveIndex(index);
      return added;
    }
  };
})();
