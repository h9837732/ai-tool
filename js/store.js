/* 本机存储层。
   优先 localStorage；浏览器禁用持久化（例如直接 file:// 打开时的隐私限制）时
   退回内存存储，并在界面上提示用户导出备份。所有数据都留在本机。 */

const Store = (function () {
  const PREFIX = 'keyapp:';
  const K_INDEX = PREFIX + 'index';
  const K_CONV = PREFIX + 'conv:';
  const K_SETTINGS = PREFIX + 'settings';
  const K_PROFILES = PREFIX + 'profiles';
  const K_ACTIVE = PREFIX + 'activeProfile';
  const K_SKILLS = PREFIX + 'skills';

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

  return {
    isPersistent: function () { return persistent; },

    loadSettings: function () { return readJSON(K_SETTINGS, null); },
    saveSettings: function (obj) { return writeRaw(K_SETTINGS, JSON.stringify(obj)); },

    /* 密钥条目：一条 = 一家服务商 + 一个 Key + 一个常用模型 */
    loadProfiles: function () { return readArray(K_PROFILES); },
    saveProfiles: function (list) { return writeRaw(K_PROFILES, JSON.stringify(list)); },

    loadActiveProfile: function () { return readRaw(K_ACTIVE) || ''; },
    saveActiveProfile: function (id) { return writeRaw(K_ACTIVE, id); },

    /* 技能库 */
    loadSkills: function () { return readArray(K_SKILLS); },
    saveSkills: function (list) { return writeRaw(K_SKILLS, JSON.stringify(list)); },

    loadIndex: function () { return readArray(K_INDEX); },
    saveIndex: function (list) { return writeRaw(K_INDEX, JSON.stringify(list)); },

    loadConv: function (id) { return readJSON(K_CONV + id, null); },
    saveConv: function (conv) { return writeRaw(K_CONV + conv.id, JSON.stringify(conv)); },
    removeConv: function (id) { removeRaw(K_CONV + id); },

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
