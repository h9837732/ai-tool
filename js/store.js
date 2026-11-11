/* 本机存储层。
   优先 localStorage；浏览器禁用持久化（例如直接 file:// 打开时的隐私限制）时
   退回内存存储，并在界面上提示用户导出备份。所有数据都留在本机。

   密钥条目（profiles）走系统安全存储：
   安卓 → Android Keystore；电脑端 → Windows DPAPI。
   启用后 localStorage 里不保留任何明文，内存里只留一份缓存维持同步读取。
   安全存储不可用（纯浏览器）时退回 localStorage 明文，并在界面上明说。 */

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
  const K_TOMB = PREFIX + 'tombstones';
  const K_SKILLS_AT = PREFIX + 'skillsAt';

  /* 当前数据结构版本。加字段不用动它，只有改了存储形态才 +1。
     v3：不再向 localStorage 写密钥（含旧的明文缓存 K_SECURE） */
  const SCHEMA = 3;

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

  let secureReady = false;      // 密钥确实已经加密存在安全区里
  let secureCapable = false;    // 系统安全区可用（哪怕现在还没有密钥）
  /* 安全存储解密后的密钥列表。loadProfiles 是同步接口（渲染要立即拿到），
     所以只能在启动时 hydrate() 一次，之后走内存。 */
  let secureMem = null;

  function securePlugin() {
    const S = (typeof Native !== 'undefined') ? Native.SecureStore : null;
    return (S && S.isNative) ? S : null;
  }

  return {
    isPersistent: function () { return persistent; },
    usesSecureProfiles: function () { return secureReady; },
    /* 安全区能不能用。和 usesSecureProfiles 的区别：
       刚装好、还没有任何密钥时，前者是 false，但加密能力是完全可用的。
       界面文案要按“能力”说，不能因为还没有密钥就说自己在存明文。 */
    isSecureAvailable: function () { return secureCapable; },
    schemaVersion: function () {
      const v = Number(readRaw(K_SCHEMA) || 0);
      return isNaN(v) ? 0 : v;
    },
    setSchemaVersion: function (v) { return writeRaw(K_SCHEMA, String(v)); },
    targetSchema: SCHEMA,

    loadSettings: function () { return readJSON(K_SETTINGS, null); },
    saveSettings: function (obj) { return writeRaw(K_SETTINGS, JSON.stringify(obj)); },

    /* ---- 密钥条目 ---- */
    /* 同步读取：安全存储已经 hydrate 过就用内存那份，否则（纯浏览器）读明文。 */
    loadProfiles: function () {
      if (secureMem) return secureMem.slice();
      return readArray(K_PROFILES);
    },

    /* 启动时把安全存储里的密钥读进内存，并清掉历史上留下的明文副本。
       返回 Promise<boolean>：true 表示已启用安全存储。 */
    hydrate: async function () {
      const S = securePlugin();
      if (!S) return false;
      const avail = await S.check();
      if (!avail) return false;
      secureCapable = true;

      const raw = await S.get('profiles');
      let list = null;
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) list = arr;
        } catch (e) { /* 解不开就当没有 */ }
      }

      if (!list) {
        /* 安全存储里没有：把明文搬进去。这是唯一会读明文的时机。 */
        const plain = readArray(K_PROFILES);
        if (plain.length) {
          const ok = await S.set('profiles', JSON.stringify(plain));
          if (ok) list = plain;
        }
      }

      if (list) {
        secureMem = list;
        secureReady = true;
        /* 明文不再需要：包括老版本留下的 K_SECURE 缓存 */
        removeRaw(K_PROFILES);
        removeRaw(K_SECURE);
        return true;
      }
      return false;
    },

    /* 异步保存：有安全存储就走它，没有就退回 localStorage。
       返回 Promise<{ ok, secure }>。 */
    saveProfiles: async function (list) {
      const json = JSON.stringify(list);
      const S = securePlugin();

      if (S) {
        const avail = await S.check();
        if (avail) {
          const ok = await S.set('profiles', json);
          if (ok) {
            secureMem = list.slice();
            secureReady = true;
            secureCapable = true;
            /* 关键：不再写任何明文副本 */
            removeRaw(K_PROFILES);
            removeRaw(K_SECURE);
            return { ok: true, secure: true };
          }
        }
      }

      /* 没有安全存储（纯浏览器）：只能明文存在 localStorage，界面上会提示 */
      const plainOk = writeRaw(K_PROFILES, json);
      return { ok: plainOk, secure: false };
    },

    loadActiveProfile: function () { return readRaw(K_ACTIVE) || ''; },
    saveActiveProfile: function (id) { return writeRaw(K_ACTIVE, id); },

    /* ---- 技能 ---- */
    loadSkills: function () { return readArray(K_SKILLS); },
    saveSkills: function (list) {
      const ok = writeRaw(K_SKILLS, JSON.stringify(list));
      writeRaw(K_SKILLS_AT, String(Date.now()));
      return ok;
    },
    skillsAt: function () { return Number(readRaw(K_SKILLS_AT) || 0) || 0; },
    loadSkillsAt: function () { return this.skillsAt(); },
    saveSkillsAt: function (ts) { return writeRaw(K_SKILLS_AT, String(Number(ts) || Date.now())); },

    /* ---- 墓碑：记录「什么时候删了哪条对话」，同步时用来防复活 ---- */
    loadTombstones: function () {
      const v = readJSON(K_TOMB, {});
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    },
    addTombstone: function (id, at, keepNewer) {
      if (!id) return;
      const t = this.loadTombstones();
      const ts = Number(at) || Date.now();
      if (keepNewer && t[id] && t[id] >= ts) return;
      t[id] = ts;
      writeRaw(K_TOMB, JSON.stringify(t));
    },
    clearTombstones: function () { removeRaw(K_TOMB); },

    /* ---- 对话 ---- */
    loadIndex: function () { return readArray(K_INDEX); },
    saveIndex: function (list) { return writeRaw(K_INDEX, JSON.stringify(list)); },

    loadConv: function (id) { return readJSON(K_CONV + id, null); },
    saveConv: function (conv) { return writeRaw(K_CONV + conv.id, JSON.stringify(conv)); },
    removeConv: function (id) {
      removeRaw(K_CONV + id);
      this.addTombstone(id, Date.now());
    },

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

      /* v2：密钥挪进系统安全存储（安卓 Keystore / 电脑 DPAPI） */
      if (from < 2) {
        const S = securePlugin();
        const plain = secureMem || readArray(K_PROFILES);
        if (S && plain.length) {
          const avail = await S.check();
          if (avail) {
            const ok = await S.set('profiles', JSON.stringify(plain));
            if (ok) {
              secureMem = plain.slice();
              secureReady = true;
              removeRaw(K_PROFILES);
              done.push('encrypted-keys');
            }
          }
        }
      }

      /* v3：清掉老版本留下的明文缓存 keyapp:secureProfiles。
         以前为了「同步读取」把密钥明文又写了一份到 localStorage，
         等于加密白做了。现在用内存缓存代替，这里把历史痕迹删干净。 */
      if (from < 3) {
        const S = securePlugin();
        const left = readRaw(K_SECURE);
        if (left) {
          let moved = secureReady;
          if (!moved && S) {
            const avail = await S.check();
            if (avail) {
              try {
                const arr = JSON.parse(left);
                if (Array.isArray(arr) && arr.length) {
                  moved = await S.set('profiles', JSON.stringify(arr));
                  if (moved) {
                    secureMem = arr;
                    secureReady = true;
                  }
                } else {
                  moved = true;       // 空数组，直接删就行
                }
              } catch (e) { /* 解不开就保留，不丢数据 */ }
            }
          }
          if (moved) {
            removeRaw(K_SECURE);
            done.push('purged-plain-cache');
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
