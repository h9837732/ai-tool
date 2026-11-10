/* 钥匙 · 自带 API Key 的 AI 对话客户端
   纯前端：请求从浏览器直接发往服务商，对话记录写在本机 localStorage。 */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */

  var APP_VERSION = '1.1.0';

  var CHANGELOG = [
    {
      v: '1.1.0',
      date: '2026-11',
      zh: [
        '设置移进对话列表，分「密钥 / 外观 / 语言 / 关于」四类',
        '新增英文界面，可随时切换',
        '默认配色改为「蓝白·大肥鱼」',
        'App 里的密钥改用系统钥匙串加密存储',
        '临时对话可直接存为正式对话',
        '不返回跨域头的服务商在 App 里改走原生请求',
        '升级不会动已有的对话、密钥和设置'
      ],
      en: [
        'Settings moved into the conversation drawer, split into Keys / Appearance / Language / About',
        'English interface, switchable at any time',
        'New default palette: Blue Fish',
        'Keys are now encrypted with the system keystore in the app',
        'Save a temporary chat as a normal one',
        'Providers without CORS headers now use native requests in the app',
        'Upgrading never touches your chats, keys or settings'
      ]
    },
    {
      v: '1.0.0',
      date: '2026-11',
      zh: [
        '13 家服务商预设，模型名核对到 2026-11',
        '多密钥条目、技能库、五档思考强度',
        '附件：相册、文件、粘贴、拖放，图片自动压缩',
        '安卓工程与云端出包'
      ],
      en: [
        '13 provider presets, model names verified 2026-11',
        'Multiple keys, skills library, five effort levels',
        'Attachments: photos, files, paste, drag-and-drop with image compression',
        'Android project and cloud APK builds'
      ]
    }
  ];

  /* 默认：蓝白·大肥鱼 */
  var DEFAULT_PREFS = {
    temperature: 1, maxTokens: 2048, systemPrompt: '', theme: 'light', intensity: 2,
    palette: 'fish', customAccent: '#2E7BD6', customBg: '#F2F8FF', lang: 'zh'
  };

  /* 配色方案：accent 为强调色，bg 为底色；每套分别给深/浅两版 */
  var PALETTES = [
    { id: 'fish', nameKey: 'pal.fish', accent: '#5AA9F5', accentLight: '#2E7BD6', bg: '#0B1620', bgLight: '#F2F8FF' },
    { id: 'brass', nameKey: 'pal.brass', accent: '#D8A25C', accentLight: '#A9691F', bg: '#0F1613', bgLight: '#F1F3F0' },
    { id: 'jade', nameKey: 'pal.jade', accent: '#6FB9A0', accentLight: '#27745F', bg: '#0C1614', bgLight: '#EFF4F1' },
    { id: 'ink', nameKey: 'pal.ink', accent: '#9FB3C8', accentLight: '#3C5872', bg: '#0D0F11', bgLight: '#F0F2F4' },
    { id: 'wine', nameKey: 'pal.wine', accent: '#C98FA6', accentLight: '#8E3F5C', bg: '#150E13', bgLight: '#F5EFF2' },
    { id: 'ember', nameKey: 'pal.ember', accent: '#E08A5B', accentLight: '#A9502A', bg: '#161010', bgLight: '#F5F0EC' },
    { id: 'custom', nameKey: 'pal.custom', accent: null, bg: null, bgLight: null }
  ];

  /* 思考强度：5 档，各自向服务商的能力映射（见 buildRequest） */
  var EFFORT = [
    { key: 'off', nameKey: 'effort.off' },
    { key: 'low', nameKey: 'effort.low' },
    { key: 'mid', nameKey: 'effort.mid' },
    { key: 'high', nameKey: 'effort.high' },
    { key: 'max', nameKey: 'effort.max' }
  ];

  /* DeepSeek：none / low / high / max（medium 归一到 high） */
  var DEEPSEEK_EFFORT = { off: 'none', low: 'low', mid: 'medium', high: 'high', max: 'max' };
  /* OpenAI 系：low / medium / high（无 none、无 max） */
  var OPENAI_EFFORT = { off: null, low: 'low', mid: 'medium', high: 'high', max: 'high' };
  /* 智谱 GLM-5.x：始终开思考，只能 low / high / max，关不掉 */
  var ZHIPU_EFFORT = { off: null, low: 'low', mid: 'high', high: 'high', max: 'max' };
  /* Claude：thinking 预算，最小 1024 */
  var ANTHROPIC_BUDGET = { off: 0, low: 1024, mid: 4096, high: 16384, max: 32768 };

  var SKILL_SAMPLES = [
    {
      nameKey: 'sample.tr.name', hintKey: 'sample.tr.hint', bodyKey: 'sample.tr.body',
      name: '翻译成英式英语',
      hint: '写论文、改句子时',
      body: '把用户给出的内容翻译成英式英语（British English），保留原文段落结构，用词和拼写遵循英式规范，不要额外解释。',
      nameEn: 'Translate to British English',
      hintEn: 'When writing papers',
      bodyEn: 'Translate what the user gives you into British English, keeping the original paragraph structure and British spelling and word choice. Do not add explanations.'
    },
    {
      name: '先给结论',
      hint: '需要快速判断时',
      body: '先用一句话给出结论，再展开理由。理由是分点的，每点不超过两行。不要写开场客套话。',
      nameEn: 'Answer first',
      hintEn: 'When you need a quick call',
      bodyEn: 'Give the conclusion in one sentence first, then the reasoning as bullet points, at most two lines each. Skip the pleasantries.'
    },
    {
      name: '代码要能跑',
      hint: '写代码、改 bug 时',
      body: '给代码时给出完整可运行的文件内容，标出文件路径。改动用注释标出原因。不要省略成省略号。',
      nameEn: 'Runnable code',
      hintEn: 'When writing or fixing code',
      bodyEn: 'Always give complete runnable file contents and label each file path. Mark changes with comments explaining why. Never abbreviate with ellipses.',
      
    },
    {
      name: '只要中文',
      hint: '中文环境',
      body: '始终用简体中文回答，专有名词保留英文原文并加括号注明。',
      nameEn: 'Chinese only',
      hintEn: 'Chinese context',
      bodyEn: 'Always answer in Simplified Chinese. Keep proper nouns in English with the Chinese in brackets.'
    }
  ];

  /* ---------- 状态 ---------- */

  var state = {
    prefs: null,        // temperature / maxTokens / systemPrompt / theme / palette / lang
    profiles: [],       // 密钥条目
    activeId: '',
    skills: [],
    index: [],
    conv: null,
    attachments: [],    // 本条消息待发的附件
    streaming: false,
    controller: null,
    pinned: true,
    persistTimer: 0,
    editingProfileId: '',
    editingSkillId: '',
    sheetBeforeProfile: 'deepseek',
    settingsTab: 'keys',
    secureOn: false
  };

  /* 附件限制 */
  var MAX_IMAGE_SIDE = 1280;      // 图片最长边缩到这个尺寸
  var IMAGE_QUALITY = 0.85;
  var MAX_TEXT_BYTES = 100 * 1024; // 单个文本文件上限
  var MAX_ATTACH_COUNT = 8;

  var el = {};
  function $(id) { return document.getElementById(id); }

  /* ---------- 工具 ---------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = 0;
  function toast(text, ms) {
    el.toast.textContent = text;
    el.toast.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.dataset.show = 'false'; }, ms || 2800);
  }

  function timeLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return hm;
    var md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(t('toast.copied')); },
        function () { fallbackCopy(text); }
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(t('toast.copied')); }
    catch (e) { toast(t('toast.copyFail')); }
    document.body.removeChild(ta);
  }

  /* ---------- 密钥条目 ---------- */

  function activeProfile() {
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === state.activeId) return state.profiles[i];
    }
    return state.profiles[0] || null;
  }

  function profileProvider(p) {
    return getProvider((p && p.providerId) || 'deepseek');
  }

  function profileLabel(p) {
    if (!p) return t('composer.noKey');
    if (p.label) return p.label;
    var prov = profileProvider(p);
    return prov.name + (p.model ? ' · ' + p.model : '');
  }

  function setActiveProfile(id) {
    state.activeId = id;
    Store.saveActiveProfile(id);
    var p = activeProfile();
    if (p) state.sheetBeforeProfile = p.providerId;
    renderProfileList();
    renderHint();
    renderEmpty();
  }

  function saveProfiles() {
    /* 保存是异步的（App 里要过一道钥匙串加密），但界面不等它 */
    Promise.resolve(Store.saveProfiles(state.profiles)).then(function (r) {
      if (!r || !r.ok) {
        toast(t('toast.storageFull'), 5000);
        return;
      }
      state.secureOn = !!r.secure;
      renderSecureNote();
    }).catch(function () { /* 已在 Store 内兜底 */ });
  }

  function renderSecureNote() {
    var text = state.secureOn ? t('keys.secureOn') : t('keys.secureOff');
    [el.secureNote, el.secureNote2].forEach(function (n) {
      if (!n) return;
      n.textContent = text;
      n.dataset.on = state.secureOn ? 'true' : 'false';
    });
  }

  function migrateLegacy() {
    // v1 只有一条全局 Key，升级时搬成第一条密钥条目。
    // 偏好项本来就存在同一个键里，loadPrefs 已经读过了，不用再搬。
    var old = Store.loadSettings() || {};
    if (!state.profiles.length && old.apiKey) {
      state.profiles.push({
        id: uid(),
        label: getProvider(old.providerId).name,
        providerId: old.providerId || 'deepseek',
        baseUrl: old.baseUrl || '',
        apiKey: old.apiKey,
        model: old.model || ''
      });
      saveProfiles();
      state.activeId = state.profiles[0].id;
      Store.saveActiveProfile(state.activeId);
    }
  }

  function renderProfileList() {
    var box = el.profileList;
    box.innerHTML = '';
    if (!state.profiles.length) {
      var none = document.createElement('p');
      none.className = 'none';
      none.textContent = t('keys.empty');
      box.appendChild(none);
      renderSecureNote();
      return;
    }
    for (var i = 0; i < state.profiles.length; i++) {
      var p = state.profiles[i];
      var prov = profileProvider(p);
      var row = document.createElement('div');
      row.className = 'prow';
      row.dataset.id = p.id;
      if (p.id === state.activeId) row.dataset.active = 'true';

      var main = document.createElement('button');
      main.type = 'button';
      main.className = 'prow-main';
      main.dataset.activate = p.id;
      var keyTail = p.apiKey ? '••••' + esc(p.apiKey.slice(-4)) : t('keys.noKey');
      main.innerHTML =
        '<span class="prow-name">' + esc(profileLabel(p)) + (p.id === state.activeId ? '<span class="prow-flag">' + t('keys.inUse') + '</span>' : '') + '</span>' +
        '<span class="prow-meta">' + esc(prov.name) + ' · ' + esc(p.model || t('keys.noModel')) + ' · ' + keyTail + '</span>';
      row.appendChild(main);

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini-btn';
      edit.dataset.edit = p.id;
      edit.textContent = t('common.edit');
      edit.setAttribute('aria-label', t('keys.editTitle'));
      row.appendChild(edit);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn danger';
      del.dataset.del = p.id;
      del.textContent = '删';
      del.setAttribute('aria-label', '删除这条密钥');
      row.appendChild(del);

      box.appendChild(row);
    }
  }

  function openProfileForm(id) {
    state.editingProfileId = id || '';
    var p = null;
    if (id) {
      for (var i = 0; i < state.profiles.length; i++) {
        if (state.profiles[i].id === id) { p = state.profiles[i]; break; }
      }
    }
    el.profileFormTitle.textContent = p ? t('keys.editTitle') : t('keys.addTitle');
    el.profileForm.hidden = false;

    populateProfileProvider(p ? p.providerId : (state.sheetBeforeProfile || 'deepseek'));
    el.pfLabel.value = p ? (p.label || '') : '';
    el.pfBase.value = p ? (p.baseUrl || '') : (profileProvider({ providerId: el.pfProvider.value }).baseUrl || '');
    el.pfKey.value = p ? (p.apiKey || '') : '';
    el.pfModel.value = p ? (p.model || '') : '';
    el.pfKey.type = 'password';
    el.btnPfToggleKey.textContent = t('keys.show');
    onProfileProviderChange(true);
    el.profileForm.scrollIntoView({ block: 'nearest' });
    setTimeout(function () { el.pfKey.focus(); }, 150);
  }

  function closeProfileForm() {
    el.profileForm.hidden = true;
    state.editingProfileId = '';
    el.pfKey.value = '';
  }

  function populateProfileProvider(selectedId) {
    el.pfProvider.innerHTML = PROVIDERS.map(function (x) {
      return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>';
    }).join('');
    el.pfProvider.value = selectedId || PROVIDERS[0].id;
    if (!el.pfProvider.value) el.pfProvider.value = PROVIDERS[0].id;
  }

  function onProfileProviderChange(silent) {
    var id = el.pfProvider.value;
    var p = getProvider(id);
    var prevId = state.sheetBeforeProfile;
    var prev = getProvider(prevId);
    var curModel = el.pfModel.value.trim();
    var looksDefault = !curModel || (prev.models || []).indexOf(curModel) >= 0;

    if (!silent) {
      if (p.baseUrl) el.pfBase.value = p.baseUrl;
      if (id === 'custom') {
        if (id !== prevId) {
          el.pfBase.value = '';
          el.pfModel.value = '';
        }
      } else if ((p.models || []).length && looksDefault) {
        el.pfModel.value = p.models[0];
      }
    }
    el.pfModelOptions.innerHTML = (p.models || []).map(function (m) {
      return '<option value="' + esc(m) + '"></option>';
    }).join('');

    var bits = [];
    if (p.note) bits.push(p.note);
    if (p.browserBlocked && !isNative) bits.push('⚠ ' + t('err.corsBlocked', { provider: p.name }));
    if (p.keyUrl) bits.push('Key: ' + p.keyUrl);
    el.pfProviderNote.textContent = bits.join(' ');
    el.pfProviderNote.dataset.warn = (p.browserBlocked && !isNative) ? 'true' : 'false';
    state.sheetBeforeProfile = id;
  }

  function saveProfileForm() {
    var wasEditing = !!state.editingProfileId;
    var label = el.pfLabel.value.trim();
    var providerId = el.pfProvider.value || 'deepseek';
    var baseUrl = el.pfBase.value.trim();
    var apiKey = el.pfKey.value.trim();
    var model = el.pfModel.value.trim();
    var prov = getProvider(providerId);

    if (!apiKey) { toast(t('keys.needKey')); el.pfKey.focus(); return; }
    if (!baseUrl && !prov.baseUrl) { toast(t('keys.needBase')); el.pfBase.focus(); return; }
    if (!model) { toast(t('keys.needModel')); el.pfModel.focus(); return; }
    if (!label) label = prov.name;

    if (state.editingProfileId) {
      for (var i = 0; i < state.profiles.length; i++) {
        if (state.profiles[i].id !== state.editingProfileId) continue;
        state.profiles[i].label = label;
        state.profiles[i].providerId = providerId;
        state.profiles[i].baseUrl = baseUrl;
        state.profiles[i].apiKey = apiKey;
        state.profiles[i].model = model;
        break;
      }
    } else {
      var np = {
        id: uid(), label: label, providerId: providerId,
        baseUrl: baseUrl, apiKey: apiKey, model: model, createdAt: Date.now()
      };
      state.profiles.push(np);
      state.activeId = np.id;
      Store.saveActiveProfile(np.id);
    }

    saveProfiles();
    closeProfileForm();
    renderProfileList();
    renderHint();
    renderEmpty();
    toast(wasEditing ? t('toast.saved') : t('skills.enabled', { name: label }));
  }

  function deleteProfile(id) {
    var p = null;
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === id) { p = state.profiles[i]; break; }
    }
    if (!p) return;
    if (!window.confirm(t('keys.deleteAsk', { name: profileLabel(p) }))) return;
    state.profiles = state.profiles.filter(function (x) { return x.id !== id; });
    if (state.editingProfileId === id) closeProfileForm();
    saveProfiles();
    if (state.activeId === id) {
      state.activeId = state.profiles.length ? state.profiles[0].id : '';
      Store.saveActiveProfile(state.activeId);
    }
    renderProfileList();
    renderHint();
    renderEmpty();
    toast(t('toast.deleted'));
  }

  async function fetchModelList() {
    var prov = getProvider(el.pfProvider.value);
    var base = (el.pfBase.value.trim() || prov.baseUrl || '').replace(/\/+$/, '');
    var key = el.pfKey.value.trim();
    if (!base) { toast(t('err.noBase')); return; }
    if (!key) { toast(t('err.noKey')); return; }

    el.btnPfFetch.disabled = true;
    el.btnPfFetch.textContent = t('keys.fetching');
    try {
      var headers = { 'authorization': 'Bearer ' + key };
      if (prov.protocol === 'anthropic') {
        headers = {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        };
      }
      var list = [];
      try {
        var res = await fetch(base + '/models', { headers: headers });
        if (!res.ok) throw new ApiError(res.status, 'HTTP ' + res.status);
        var j = await res.json();
        list = (j.data || j.models || []).map(function (x) {
          return typeof x === 'string' ? x : (x.id || x.name || '');
        }).filter(Boolean);
      } catch (e) {
        /* 浏览器被跨域拦下时，App 里改走原生请求再试一次 */
        if (isNative && Native.NativeHttp.hasPlugin()) {
          var r = await Native.NativeHttp.request(base + '/models', headers, {});
          if (r && r.ok) {
            try {
              var jj = JSON.parse(r.text);
              list = (jj.data || jj.models || []).map(function (x) {
                return typeof x === 'string' ? x : (x.id || x.name || '');
              }).filter(Boolean);
            } catch (e2) { throw e; }
          } else { throw e; }
        } else { throw e; }
      }
      list = list.sort();
      if (!list.length) throw new Error('empty');
      el.pfModelOptions.innerHTML = list.map(function (m) {
        return '<option value="' + esc(m) + '"></option>';
      }).join('');
      if (list.indexOf(el.pfModel.value.trim()) < 0) el.pfModel.value = list[0];
      toast(list.length + ' models');
    } catch (err) {
      toast((err && err.message ? err.message : '') + ' — ' + t('keys.fetch'), 5000);
    } finally {
      el.btnPfFetch.disabled = false;
      el.btnPfFetch.textContent = t('keys.fetch');
    }
  }

  /* ---------- 技能 ---------- */

  function enabledSkills() {
    return state.skills.filter(function (s) { return s.enabled && String(s.body || '').trim(); });
  }

  function saveSkills() {
    if (!Store.saveSkills(state.skills)) toast(t('toast.storageFull'), 4000);
  }

  function renderSkillList() {
    var box = el.skillList;
    box.innerHTML = '';
    if (!state.skills.length) {
      var none = document.createElement('p');
      none.className = 'none';
      none.textContent = '还没有技能。点「新增」写一个，或者从下面的示例里挑。';
      box.appendChild(none);
      renderSampleChips();
      return;
    }
    for (var i = 0; i < state.skills.length; i++) {
      var s = state.skills[i];
      var row = document.createElement('div');
      row.className = 'srow';
      row.dataset.id = s.id;

      var main = document.createElement('div');
      main.className = 'srow-main';
      main.innerHTML =
        '<span class="srow-name">' + esc(s.name || t('skills.title')) + '</span>' +
        '<span class="srow-hint">' + esc(s.hint || String(s.body || '').slice(0, 40)) + '</span>';
      row.appendChild(main);

      var sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
      sw.setAttribute('aria-label', (s.enabled ? '✓' : '✗') + ' ' + (s.name || ''));
      sw.dataset.toggle = s.id;
      sw.innerHTML = '<span class="knob"></span>';
      row.appendChild(sw);

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini-btn';
      edit.dataset.sedit = s.id;
      edit.textContent = t('common.edit');
      edit.setAttribute('aria-label', t('skills.editTitle'));
      row.appendChild(edit);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn danger';
      del.dataset.sdel = s.id;
      del.textContent = t('common.delete');
      del.setAttribute('aria-label', t('common.delete'));
      row.appendChild(del);

      box.appendChild(row);
    }
    renderSampleChips();
  }

  function renderSampleChips() {
    var box = el.skillSamples;
    if (!box) return;
    box.innerHTML = '';
    for (var i = 0; i < SKILL_SAMPLES.length; i++) {
      var s = SKILL_SAMPLES[i];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.sample = String(i);
      b.textContent = I18N.getLang() === 'en' ? (s.nameEn || s.name) : s.name;
      box.appendChild(b);
    }
  }

  function openSkillForm(id) {
    state.editingSkillId = id || '';
    var s = null;
    if (id) {
      for (var i = 0; i < state.skills.length; i++) {
        if (state.skills[i].id === id) { s = state.skills[i]; break; }
      }
    }
    el.skillFormTitle.textContent = s ? t('skills.editTitle') : t('skills.addTitle');
    el.skillForm.hidden = false;
    el.sfName.value = s ? (s.name || '') : '';
    el.sfHint.value = s ? (s.hint || '') : '';
    el.sfBody.value = s ? (s.body || '') : '';
    el.skillForm.scrollIntoView({ block: 'nearest' });
    setTimeout(function () { el.sfName.focus(); }, 150);
  }

  function closeSkillForm() {
    el.skillForm.hidden = true;
    state.editingSkillId = '';
  }

  function saveSkillForm() {
    var name = el.sfName.value.trim();
    var hint = el.sfHint.value.trim();
    var body = el.sfBody.value.trim();
    if (!name) { toast(t('skills.needName')); el.sfName.focus(); return; }
    if (!body) { toast(t('skills.needBody')); el.sfBody.focus(); return; }

    if (state.editingSkillId) {
      for (var i = 0; i < state.skills.length; i++) {
        if (state.skills[i].id !== state.editingSkillId) continue;
        state.skills[i].name = name;
        state.skills[i].hint = hint;
        state.skills[i].body = body;
        break;
      }
    } else {
      state.skills.push({ id: uid(), name: name, hint: hint, body: body, enabled: true, createdAt: Date.now() });
      toast(t('skills.enabled', { name: name }));
    }
    saveSkills();
    closeSkillForm();
    renderSkillList();
    renderHint();
    renderEmpty();
  }

  function deleteSkill(id) {
    var s = null;
    for (var i = 0; i < state.skills.length; i++) {
      if (state.skills[i].id === id) { s = state.skills[i]; break; }
    }
    if (!s) return;
    if (!window.confirm(t('skills.deleteAsk', { name: s.name || '' }))) return;
    state.skills = state.skills.filter(function (x) { return x.id !== id; });
    if (state.editingSkillId === id) closeSkillForm();
    saveSkills();
    renderSkillList();
    renderHint();
    renderEmpty();
  }

  function toggleSkill(id) {
    for (var i = 0; i < state.skills.length; i++) {
      if (state.skills[i].id !== id) continue;
      state.skills[i].enabled = !state.skills[i].enabled;
      break;
    }
    saveSkills();
    renderSkillList();
    renderHint();
    renderEmpty();
  }

  function updateSkillBadge() {
    var n = enabledSkills().length;
    el.skillBadge.textContent = String(n);
    el.skillBadge.hidden = n === 0;
    el.btnSkillIcon.title = n ? ('技能（' + n + ' 个已启用）') : '技能';
  }

  /* 拼出最终的 system prompt */
  function composedSystem() {
    var parts = [];
    var base = String(state.prefs.systemPrompt || '').trim();
    if (base) parts.push(base);
    var list = enabledSkills();
    for (var i = 0; i < list.length; i++) {
      parts.push('【' + (list[i].name || '技能') + '】\n' + String(list[i].body).trim());
    }
    return parts.join('\n\n');
  }

  /* ---------- 偏好 ---------- */

  function loadPrefs() {
    var saved = Store.loadSettings() || {};
    var p = {};
    for (var k in DEFAULT_PREFS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, k)) continue;
      p[k] = Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : DEFAULT_PREFS[k];
    }
    state.prefs = p;
  }

  function savePrefs() { Store.saveSettings(state.prefs); }

  function currentEffort() {
    var i = Number(state.prefs.intensity);
    if (isNaN(i) || i < 0 || i > 4) i = 2;
    return EFFORT[i];
  }

  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  function providerSupportsEffort(prov) {
    return !!(prov && prov.reasoning);
  }

  function renderEffort() {
    var e = currentEffort();
    if (!el.effortName) return;
    el.effortName.textContent = t(e.nameKey);
    el.effortPopName.textContent = t(e.nameKey);
    el.effortRange.value = String(state.prefs.intensity);
    el.btnEffort.dataset.off = e.key === 'off' ? 'true' : 'false';

    var labels = el.effortTicksLabels.children;
    for (var i = 0; i < labels.length; i++) {
      if (i === Number(state.prefs.intensity)) labels[i].classList.add('on');
      else labels[i].classList.remove('on');
    }

    var prov = profileProvider(activeProfile());
    var ok = providerSupportsEffort(prov);
    el.effortNote.textContent = ok ? '' : t('effort.unsupported');
    el.effortNote.hidden = ok;
  }

  /* 上下文环：填充比例 = 已用字符 / 裁忪上限 */
  var CTX_LIMIT = 120000;

  function renderCtx() {
    if (!el.ctxBar) return;
    var chars = 0;
    var msgs = (state.conv && state.conv.messages) || [];
    for (var i = 0; i < msgs.length; i++) chars += (msgs[i].content || '').length;
    var pct = Math.min(1, chars / CTX_LIMIT);
    var C = 2 * Math.PI * 8.5;
    el.ctxBar.setAttribute('stroke-dasharray', (C * pct).toFixed(1) + ' ' + C.toFixed(1));
    el.ctxRing.dataset.warn = pct > 0.8 ? 'true' : 'false';
    el.ctxRing.title = t('tool.ctx') + ' ' + Math.round(pct * 100) + '% · ' + chars + '/' + CTX_LIMIT;
    el.ctxRing.setAttribute('aria-label', t('tool.ctx') + ' ' + Math.round(pct * 100) + '%');
  }

  function setEffort(idx) {
    state.prefs.intensity = idx;
    savePrefs();
    renderHint();
  }

  /* ---------- 配色 ---------- */

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return [0, 0, 0];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map(function (v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) { return v / 255; }).map(function (v) {
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function blend(base, over, ratio) {
    var a = hexToRgb(base);
    var b = hexToRgb(over);
    return rgbToHex([
      a[0] + (b[0] - a[0]) * ratio,
      a[1] + (b[1] - a[1]) * ratio,
      a[2] + (b[2] - a[2]) * ratio
    ]);
  }

  function contrastInk(hex) {
    return luminance(hex) > 0.45 ? '#161008' : '#FFF7EA';
  }

  /* 给定 accent 与 bg，推导整套变量 */
  function deriveVars(accent, bg) {
    var dark = luminance(bg) < 0.35;
    var step = dark ? 1 : 0;
    return {
      '--bg': bg,
      '--surface': blend(bg, dark ? '#FFFFFF' : '#000000', dark ? 0.055 : 0.035),
      '--raise': blend(bg, dark ? '#FFFFFF' : '#000000', dark ? 0.105 : 0.075),
      '--line': blend(bg, dark ? '#FFFFFF' : '#000000', dark ? 0.16 : 0.14),
      '--text': dark ? blend(bg, '#FFFFFF', 0.9) : blend(bg, '#000000', 0.85),
      '--muted': dark ? blend(bg, '#FFFFFF', 0.52) : blend(bg, '#000000', 0.48),
      '--accent': accent,
      '--accent-ink': contrastInk(accent),
      '--mark-bot': accent,
      '--mark-user': dark ? blend(bg, '#8FB4CC', 0.85) : blend(bg, '#3F6B85', 0.9),
      '--danger': dark ? '#D97A6C' : '#B0453B'
    };
  }

  function clearVarOverrides() {
    var names = ['--bg', '--surface', '--raise', '--line', '--text', '--muted',
      '--accent', '--accent-ink', '--mark-bot', '--mark-user', '--danger'];
    for (var i = 0; i < names.length; i++) {
      document.documentElement.style.removeProperty(names[i]);
    }
  }

  function paletteById(id) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) return PALETTES[i];
    }
    return PALETTES[0];
  }

  function applyTheme() {
    var pref = state.prefs ? state.prefs.theme : 'light';
    var eff = pref;
    if (pref === 'auto') {
      eff = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = eff;

    var pal = paletteById(state.prefs.palette || 'fish');
    var accent, bg;
    if (pal.id === 'custom') {
      accent = state.prefs.customAccent || '#2E7BD6';
      bg = eff === 'light'
        ? blend(state.prefs.customBg || '#F2F8FF', '#FFFFFF', 0.55)
        : (state.prefs.customBg || '#0B1620');
    } else {
      accent = eff === 'light' ? (pal.accentLight || pal.accent) : pal.accent;
      bg = eff === 'light' ? (pal.bgLight || '#F2F8FF') : pal.bg;
    }

    clearVarOverrides();
    var vars = deriveVars(accent, bg);
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        document.documentElement.style.setProperty(k, vars[k]);
      }
    }

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
    var metaScheme = document.querySelector('meta[name="color-scheme"]');
    if (metaScheme) metaScheme.setAttribute('content', eff === 'light' ? 'light dark' : 'dark light');
    document.documentElement.style.colorScheme = eff;
  }

  function renderPaletteList() {
    var box = el.paletteList;
    if (!box) return;
    box.innerHTML = '';
    var current = state.prefs.palette || 'fish';
    for (var i = 0; i < PALETTES.length; i++) {
      var p = PALETTES[i];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal';
      b.dataset.pal = p.id;
      if (p.id === current) b.dataset.on = 'true';
      var swatchBg = p.id === 'custom'
        ? (state.prefs.customBg || '#F2F8FF')
        : p.bgLight;
      var swatchAccent = p.id === 'custom'
        ? (state.prefs.customAccent || '#2E7BD6')
        : (p.accentLight || p.accent);
      b.innerHTML =
        '<span class="pal-dot" style="background:' + esc(swatchBg) + '">' +
        '<i style="background:' + esc(swatchAccent) + '"></i></span>' +
        '<span class="pal-name">' + esc(t(p.nameKey)) + '</span>';
      box.appendChild(b);
    }
    if (el.paletteCustom) el.paletteCustom.hidden = current !== 'custom';
  }

  function fillPrefsForm() {
    el.fSystem.value = state.prefs.systemPrompt || '';
    el.fTemp.value = String(state.prefs.temperature == null ? 1 : state.prefs.temperature);
    el.tempVal.textContent = Number(el.fTemp.value).toFixed(1);
    el.fMax.value = String(state.prefs.maxTokens || 2048);
    el.fTheme.value = state.prefs.theme || 'light';
    el.fAccent.value = state.prefs.customAccent || '#2E7BD6';
    el.fBg.value = state.prefs.customBg || '#F2F8FF';
    renderPaletteList();
    renderLangList();
  }

  function renderLangList() {
    if (!el.langList) return;
    var btns = el.langList.querySelectorAll('.lang');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].dataset.lang === I18N.getLang()) btns[i].dataset.on = 'true';
      else delete btns[i].dataset.on;
    }
  }

  function readPrefsForm() {
    state.prefs.systemPrompt = el.fSystem.value;
    state.prefs.temperature = Number(el.fTemp.value);
    state.prefs.maxTokens = Number(el.fMax.value) || 2048;
    state.prefs.theme = el.fTheme.value;
    savePrefs();
    applyTheme();
  }

  /* ---------- 附件 ---------- */

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function extOf(name) {
    var i = String(name).lastIndexOf('.');
    return i >= 0 ? String(name).slice(i + 1).toLowerCase() : '';
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('读文件失败')); };
      r.readAsDataURL(file);
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('读文件失败')); };
      r.readAsText(file);
    });
  }

  /* 图片缩到最长边 1280，转 JPEG，避免 base64 把存储和上下文撑爆 */
  function shrinkImage(file) {
    return readAsDataUrl(file).then(function (src) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth;
          var h = img.naturalHeight;
          var scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          if (scale === 1 && file.size < 400 * 1024) { resolve(src); return; }
          var cv = document.createElement('canvas');
          cv.width = cw;
          cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          var out;
          try { out = cv.toDataURL('image/jpeg', IMAGE_QUALITY); }
          catch (e) { out = src; }
          resolve(out);
        };
        img.onerror = function () { resolve(src); };
        img.src = src;
      });
    });
  }

  function addImageFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var room = MAX_ATTACH_COUNT - state.attachments.length;
    if (room <= 0) { toast(t('toast.maxAttach', { n: MAX_ATTACH_COUNT })); return; }
    if (list.length > room) {
      list = list.slice(0, room);
      toast(t('toast.tooManyAttach', { n: room }));
    }
    var jobs = list.map(function (f) {
      return shrinkImage(f).then(function (dataUrl) {
        state.attachments.push({
          id: uid(), kind: 'image', name: f.name || 'image',
          size: Math.round(dataUrl.length * 0.75), dataUrl: dataUrl
        });
      }).catch(function () {
        toast(t('toast.attachFail', { name: f.name || 'image' }), 3000);
      });
    });
    Promise.all(jobs).then(function () {
      renderAttachments();
      var prov = profileProvider(activeProfile());
      if (!prov.vision) toast(t('toast.noVision', { provider: prov.name }), 6000);
    });
  }

  function addTextFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var room = MAX_ATTACH_COUNT - state.attachments.length;
    if (room <= 0) { toast(t('toast.maxAttach', { n: MAX_ATTACH_COUNT })); return; }
    if (list.length > room) list = list.slice(0, room);

    var tooBig = list.filter(function (f) { return f.size > MAX_TEXT_BYTES; });
    if (tooBig.length) {
      var names = tooBig.map(function (f) { return f.name; }).join(', ');
      if (!window.confirm(t('toast.bigFile', { names: names }))) {
        list = list.filter(function (f) { return f.size <= MAX_TEXT_BYTES; });
        if (!list.length) return;
      }
    }

    var jobs = list.map(function (f) {
      return readAsText(f).then(function (text) {
        state.attachments.push({
          id: uid(), kind: 'text', name: f.name || 'file',
          size: f.size, text: text
        });
      }).catch(function () {
        toast(t('toast.attachFail', { name: f.name || 'file' }), 3000);
      });
    });
    Promise.all(jobs).then(renderAttachments);
  }

  function removeAttachment(id) {
    state.attachments = state.attachments.filter(function (a) { return a.id !== id; });
    renderAttachments();
  }

  function extIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  }

  function attNode(att, removable) {
    var box = document.createElement('div');
    box.className = 'att';

    if (att.kind === 'image' && att.dataUrl) {
      var img = document.createElement('img');
      img.className = 'att-thumb';
      img.src = att.dataUrl;
      img.alt = att.name || '图片';
      box.appendChild(img);
    } else {
      var ic = document.createElement('span');
      ic.className = 'att-icon';
      ic.innerHTML = extIconSvg();
      box.appendChild(ic);
    }

    var meta = document.createElement('span');
    meta.className = 'att-meta';
    meta.innerHTML = '<span class="att-name">' + esc(att.name || '') + '</span>' +
      '<span class="att-size">' + (att.kind === 'image' ? '图片 · ' : '文本 · ') + fmtSize(att.size || 0) + '</span>';
    box.appendChild(meta);

    if (removable) {
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'att-x';
      x.textContent = '×';
      x.setAttribute('aria-label', '移除 ' + (att.name || '附件'));
      x.addEventListener('click', function () { removeAttachment(att.id); });
      box.appendChild(x);
    }
    return box;
  }

  function renderAttachments() {
    var strip = el.attachStrip;
    strip.innerHTML = '';
    if (!state.attachments.length) { strip.hidden = true; return; }
    strip.hidden = false;
    for (var i = 0; i < state.attachments.length; i++) {
      strip.appendChild(attNode(state.attachments[i], true));
    }
    autoGrow();
  }

  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }

  /* 把附件折进请求体 */
  function contentParts(text, atts, protocol) {
    var images = [];
    var docs = [];
    for (var i = 0; i < (atts || []).length; i++) {
      var a = atts[i];
      if (a.kind === 'image' && a.dataUrl) images.push(a);
      else if (a.kind === 'text' && a.text) docs.push(a);
    }

    var full = text || '';
    for (var j = 0; j < docs.length; j++) {
      var ext = extOf(docs[j].name);
      full += (full ? '\n\n' : '') + '【' + docs[j].name + '】\n```' + ext + '\n' + docs[j].text + '\n```';
    }

    if (!images.length) return full;

    if (protocol === 'anthropic') {
      var parts = images.map(function (a) {
        var m = String(a.dataUrl).match(/^data:([^;]+);base64,(.*)$/);
        if (!m) return null;
        return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      }).filter(Boolean);
      parts.push({ type: 'text', text: full });
      return parts;
    }

    var out = images.map(function (a) {
      return { type: 'image_url', image_url: { url: a.dataUrl } };
    });
    out.push({ type: 'text', text: full });
    return out;
  }

  /* ---------- 对话管理 ---------- */

  function newConv(temp) {
    if (state.streaming) stopGeneration();
    persistNow();
    state.conv = {
      id: uid(),
      title: t('bar.newChat'),
      model: '',
      temp: !!temp,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    renderStream();
    renderEmpty();
    renderTitle();
    renderBarState();
    if (!state.conv.temp) persistNow();
    el.input.value = '';
    clearAttachments();
    autoGrow();
  }

  /* 顶栏右侧：空对话时可切临时，临时且已有内容时显示保存 */
  function renderBarState() {
    var conv = state.conv;
    if (!conv) {
      el.btnTemp.hidden = true;
      el.btnSaveTemp.hidden = true;
      return;
    }
    var empty = !conv.messages.length;
    var isTemp = !!conv.temp;

    // 空对话：显示「临时 / 正式」切换
    el.btnTemp.hidden = !empty;
    if (empty) {
      el.btnTemp.textContent = isTemp ? t('bar.tempOn') : t('bar.formalOn');
      el.btnTemp.dataset.on = isTemp ? 'true' : 'false';
      el.btnTemp.title = isTemp ? t('bar.tempTipOn') : t('bar.tempTipOff');
      el.btnTemp.setAttribute('aria-label', el.btnTemp.title);
    }

    // 临时且有内容：显示保存（顶栏 + 加号菜单两处都能保存）
    var canSave = isTemp && !empty;
    el.btnSaveTemp.hidden = !canSave;
    el.btnSaveTemp.textContent = t('bar.saveTemp');
    el.btnSaveTemp.title = t('bar.saveTempTip');
    el.btnSaveTemp.setAttribute('aria-label', t('bar.saveTempTip'));
    if (el.menuSaveTemp) el.menuSaveTemp.hidden = !canSave;
  }

  function toggleTemp() {
    var conv = state.conv;
    if (!conv || conv.messages.length) return;
    conv.temp = !conv.temp;
    if (conv.temp) {
      // 从正式转临时：从索引和存储中抽走
      Store.removeConv(conv.id);
      state.index = state.index.filter(function (x) { return x.id !== conv.id; });
      Store.saveIndex(state.index);
      renderConvList();
      toast(t('toast.tempOn'));
    } else {
      persistNow();
      toast(t('toast.tempOff'));
    }
    renderBarState();
    renderEmpty();
    renderHint();
  }

  function saveTempConv() {
    var conv = state.conv;
    if (!conv || !conv.temp) return;
    conv.temp = false;
    // 补一个能认出来的标题
    if (!conv.title || conv.title === t('bar.newChat') || conv.title === '新对话') {
      for (var i = 0; i < conv.messages.length; i++) {
        if (conv.messages[i].role === 'user' && conv.messages[i].content) {
          var raw = String(conv.messages[i].content).replace(/\s+/g, ' ').trim();
          conv.title = raw.length > 24 ? raw.slice(0, 24) + '…' : (raw || t('bar.newChat'));
          break;
        }
      }
    }
    persistNow();
    renderTitle();
    renderBarState();
    renderEmpty();
    renderHint();
    toast(t('toast.savedToList'));
  }

  function openConv(id) {
    if (state.streaming) stopGeneration();
    var conv = Store.loadConv(id);
    if (!conv) { toast(t('err.other', { msg: 'conv' })); return; }
    persistNow();
    state.conv = conv;
    if (!Array.isArray(conv.messages)) conv.messages = [];
    renderStream();
    renderEmpty();
    renderTitle();
    renderBarState();
    renderConvList();
    el.stream.scrollTop = el.stream.scrollHeight;
  }

  function persist() {
    clearTimeout(state.persistTimer);
    if (state.conv && state.conv.temp) return;
    state.persistTimer = setTimeout(persistNow, 200);
  }

  function persistNow() {
    clearTimeout(state.persistTimer);
    if (!state.conv) return;
    var conv = state.conv;
    if (conv.temp) { renderBarState(); return; }
    conv.updatedAt = Date.now();
    var okConv = Store.saveConv(conv);
    var meta = { id: conv.id, title: conv.title, model: conv.model, updatedAt: conv.updatedAt };
    var i = -1;
    for (var n = 0; n < state.index.length; n++) {
      if (state.index[n].id === conv.id) { i = n; break; }
    }
    if (i >= 0) state.index[i] = meta; else state.index.unshift(meta);
    state.index.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var okIndex = Store.saveIndex(state.index);
    if (!okConv || !okIndex) {
      toast(t('toast.storageFull'), 6000);
    }
    renderConvList();
    renderCtx();
    renderBarState();
  }

  function removeConv(id) {
    var conv = Store.loadConv(id);
    var name = conv ? conv.title : '这条对话';
    if (!window.confirm('删除「' + name + '」？删掉就找不回来了。')) return;
    Store.removeConv(id);
    state.index = state.index.filter(function (x) { return x.id !== id; });
    Store.saveIndex(state.index);
    if (state.conv && state.conv.id === id) {
      if (state.index.length) openConv(state.index[0].id);
      else newConv();
    }
    renderConvList();
    toast(t('toast.deleted'));
  }

  function renameConv(id) {
    var conv = Store.loadConv(id);
    if (!conv) return;
    var name = window.prompt(t('drawer.rename'), conv.title);
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    conv.title = name.slice(0, 60);
    Store.saveConv(conv);
    for (var i = 0; i < state.index.length; i++) {
      if (state.index[i].id === id) state.index[i].title = conv.title;
    }
    if (state.conv && state.conv.id === id) { state.conv.title = conv.title; renderTitle(); }
    Store.saveIndex(state.index);
    renderConvList();
  }

  function maybeRetitle(raw) {
    if (!state.conv) return;
    if (state.conv.title && state.conv.title !== t('bar.newChat') && state.conv.title !== '新对话') return;
    var s = String(raw).replace(/\s+/g, ' ').trim();
    state.conv.title = s.length > 24 ? s.slice(0, 24) + '…' : s;
    renderTitle();
  }

  /* ---------- 渲染 ---------- */

  function renderTitle() {
    el.convTitle.textContent = (state.conv && state.conv.title) || t('bar.newChat');
  }

  /* 离开临时对话前提醒：临时内容不会进列表 */
  function leaveTempIfNeeded(next) {
    var conv = state.conv;
    if (conv && conv.temp && conv.messages.length) {
      if (!window.confirm(t('toast.leaveTemp'))) return;
    }
    next();
  }

  function renderHint() {
    var p = activeProfile();
    var bits = [];
    if (!p) bits.push(t('composer.noKey'));
    else bits.push(p.model || t('composer.noModel'));
    bits.push(t('effort.title') + ' ' + t(currentEffort().nameKey));
    var n = enabledSkills().length;
    if (n) bits.push(t('tool.skills') + ' ' + n);
    if (state.conv && state.conv.temp) bits.push(t('composer.tempMark'));

    var warn = !p || (profileProvider(p).browserBlocked && !isNative);
    el.statusLine.textContent = bits.join(' · ');
    el.statusLine.dataset.warn = warn ? 'true' : 'false';
    el.modelName.textContent = p ? (p.model || t('composer.noModel')) : t('composer.noKey');

    updateSkillBadge();
    renderEffort();
    renderCtx();
    renderBarState();
  }

  function renderConvList() {
    var list = el.convList;
    list.innerHTML = '';
    if (!state.index.length) {
      var none = document.createElement('p');
      none.className = 'conv-none';
      none.textContent = t('drawer.empty');
      list.appendChild(none);
      return;
    }
    for (var i = 0; i < state.index.length; i++) {
      var item = state.index[i];
      var row = document.createElement('div');
      row.className = 'conv-row';
      if (state.conv && state.conv.id === item.id) row.dataset.active = 'true';

      var open = document.createElement('button');
      open.className = 'conv-open';
      open.dataset.id = item.id;
      open.innerHTML = '<span class="conv-row-title">' + esc(item.title || t('bar.newChat')) + '</span>' +
        '<span class="conv-row-meta">' + esc(item.model || '') + ' · ' + timeLabel(item.updatedAt) + '</span>';
      row.appendChild(open);

      var mdBtn = document.createElement('button');
      mdBtn.className = 'conv-mini';
      mdBtn.dataset.md = item.id;
      mdBtn.setAttribute('aria-label', 'MD');
      mdBtn.textContent = 'MD';
      row.appendChild(mdBtn);

      var del = document.createElement('button');
      del.className = 'conv-mini danger';
      del.dataset.del = item.id;
      del.setAttribute('aria-label', t('common.delete'));
      del.textContent = t('common.delete');
      row.appendChild(del);

      list.appendChild(row);
    }
  }

  function renderStream() {
    el.stream.innerHTML = '';
    el.stream.appendChild(el.emptyState);
    var msgs = (state.conv && state.conv.messages) || [];
    for (var i = 0; i < msgs.length; i++) {
      el.stream.appendChild(msgNode(msgs[i], i));
    }
    renderCtx();
  }

  function renderEmpty() {
    var p = activeProfile();
    var hasKey = !!(p && p.apiKey);
    var hasMsgs = state.conv && state.conv.messages && state.conv.messages.length > 0;
    el.emptyState.hidden = !!hasMsgs;
    if (hasMsgs) return;

    if (!hasKey) {
      el.emptyState.innerHTML =
        '<p class="empty-lead">' + esc(t('empty.noKey.lead')) + '</p>' +
        '<p class="empty-text">' + esc(t('empty.noKey.text')) + '</p>' +
        '<button class="btn-primary" type="button" data-act="open-keys">' + esc(t('empty.noKey.btn')) + '</button>';
    } else {
      var prov = profileProvider(p);
      var skillN = enabledSkills().length;
      el.emptyState.innerHTML =
        '<p class="empty-lead">' + esc(t('empty.ready.lead')) + '</p>' +
        '<p class="empty-text">' + esc(p.model || t('composer.noModel')) +
        (skillN ? ' · ' + skillN + ' ' + esc(t('tool.skills')) : '') +
        (state.conv && state.conv.temp ? ' · ' + esc(t('composer.tempMark')) : '') +
        (prov.browserBlocked && !isNative ? '<br>' + esc(t('composer.blockedHint')) : '') + '</p>' +
        '<div class="chips">' +
        '<button class="chip" type="button" data-fill="' + esc(t('empty.fill1')) + '">' + esc(t('empty.chip1')) + '</button>' +
        '<button class="chip" type="button" data-fill="' + esc(t('empty.fill2')) + '">' + esc(t('empty.chip2')) + '</button>' +
        '<button class="chip" type="button" data-act="open-skills">' + esc(t('empty.chip3')) + '</button>' +
        '</div>';
    }
  }

  function mkBtn(label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function reasoningBlock(msg) {
    var details = document.createElement('details');
    details.className = 'reasoning';
    if (msg.reasoningOpen) details.open = true;
    details.addEventListener('toggle', function () { msg.reasoningOpen = details.open; });
    var summary = document.createElement('summary');
    summary.textContent = t('msg.reasoning');
    details.appendChild(summary);
    var body = document.createElement('div');
    body.className = 'think-body';
    body.textContent = msg.reasoning || '';
    details.appendChild(body);
    return details;
  }

  function setActions(node, msg, idx) {
    var acts = node.querySelector('.msg-acts');
    if (!acts) {
      acts = document.createElement('div');
      acts.className = 'msg-acts';
      node.appendChild(acts);
    }
    acts.innerHTML = '';
    if (msg.content) acts.appendChild(mkBtn(t('common.copy'), function () { copyText(msg.content); }));
    if (msg.reasoning) acts.appendChild(mkBtn(t('common.copyThink'), function () { copyText(msg.reasoning); }));
    if (msg.role === 'assistant' && state.conv && idx === state.conv.messages.length - 1 && !state.streaming) {
      acts.appendChild(mkBtn(t('common.regenerate'), regenerate));
    }
  }

  function msgNode(msg, idx) {
    var node = document.createElement('article');
    node.className = 'msg ' + (msg.role === 'user' ? 'user' : 'bot');
    node.dataset.idx = String(idx);

    var head = document.createElement('div');
    head.className = 'msg-head';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.role === 'user' ? t('msg.you') : (msg.model || 'AI');
    head.appendChild(who);
    if (msg.at) {
      var when = document.createElement('span');
      when.textContent = timeLabel(msg.at);
      head.appendChild(when);
    }
    if (msg.skills && msg.skills.length) {
      var sk = document.createElement('span');
      sk.className = 'msg-skills';
      sk.textContent = t('tool.skills') + ' ' + msg.skills.length;
      sk.title = msg.skills.join(', ');
      head.appendChild(sk);
    }
    node.appendChild(head);

    if (msg.reasoning) node.appendChild(reasoningBlock(msg));

    if (msg.attachments && msg.attachments.length) {
      var strip = document.createElement('div');
      strip.className = 'msg-atts';
      for (var ai = 0; ai < msg.attachments.length; ai++) {
        strip.appendChild(attNode(msg.attachments[ai], false));
      }
      node.appendChild(strip);
    }

    var body = document.createElement('div');
    body.className = 'msg-body prose';
    body.innerHTML = mdToHtml(msg.content || '');
    node.appendChild(body);

    if (msg.error) node.dataset.error = 'true';
    setActions(node, msg, idx);
    return node;
  }

  function appendNode(node) {
    el.emptyState.hidden = true;
    el.stream.appendChild(node);
    autoScroll(true);
  }

  /* ---------- 滚动 ---------- */

  function autoScroll(force) {
    if (force || state.pinned) el.stream.scrollTop = el.stream.scrollHeight;
  }

  function onStreamScroll() {
    var s = el.stream;
    state.pinned = (s.scrollHeight - s.scrollTop - s.clientHeight) < 140;
  }

  /* ---------- 请求 ---------- */

  function ApiError(status, message, raw) {
    this.name = 'ApiError';
    this.status = status;
    this.message = message;
    this.raw = raw;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function pickServerMessage(raw) {
    if (!raw) return '';
    try {
      var j = JSON.parse(raw);
      if (j.error && j.error.message) return j.error.message;
      if (j.message) return j.message;
      if (j.error && typeof j.error === 'string') return j.error;
      if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch (e) { /* 非 JSON */ }
    return String(raw).slice(0, 200);
  }

  function errorText(err) {
    var prof = activeProfile();
    var prov = profileProvider(prof);

    if (err && err.name === 'ApiError') {
      var known = [400, 401, 402, 403, 404, 413, 422, 429, 500, 502, 503];
      var text = t('err.http', { status: err.status });
      if (known.indexOf(err.status) >= 0) text = t('err.' + err.status);
      if (/\bmodel\b/i.test(err.message || '') && known.indexOf(err.status) < 0) {
        text = t('err.modelBad', { msg: err.message });
      }
      return text + (err.message ? '\n\n' + t('err.providerSays', { msg: err.message }) : '');
    }

    if (err && err.name === 'AbortError') return t('common.stopped');
    if (!navigator.onLine) return t('err.offline');

    if (err && (err.name === 'TypeError' || err.name === 'NetworkError' || /fetch/i.test(err.message || ''))) {
      if (prov.browserBlocked && !isNative) {
        return t('err.corsBlocked', { provider: prov.name });
      }
      return t('err.network', {
        provider: prov.name,
        base: (prof && prof.baseUrl) || '-'
      });
    }

    return t('err.other', { msg: (err && err.message) || String(err) });
  }

  function trimHistory(msgs) {
    var LIMIT = 120000;
    var total = 0;
    for (var i = 0; i < msgs.length; i++) {
      total += typeof msgs[i].content === 'string'
        ? msgs[i].content.length
        : JSON.stringify(msgs[i].content).length;
    }
    if (total <= LIMIT) return msgs;
    var cut = 0;
    while (total > LIMIT && cut < msgs.length - 2) {
      total -= typeof msgs[cut].content === 'string'
        ? msgs[cut].content.length
        : JSON.stringify(msgs[cut].content).length;
      cut++;
    }
    while (cut < msgs.length - 1 && msgs[cut].role !== 'user') cut++;
    return msgs.slice(cut);
  }

  function buildRequest(history) {
    var prof = activeProfile();
    if (!prof) throw new Error(t('err.noProfile'));
    var prov = profileProvider(prof);
    var base = String(prof.baseUrl || prov.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error(t('err.noBase'));
    if (!prof.apiKey) throw new Error(t('err.noKey'));
    if (!prof.model) throw new Error(t('err.noModel'));

    var msgs = [];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      var hasText = typeof m.content === 'string' && m.content;
      var hasAtt = Array.isArray(m.attachments) && m.attachments.length;
      if (!hasText && !hasAtt) continue;
      msgs.push({
        role: m.role,
        content: contentParts(m.content || '', m.attachments, prov.protocol)
      });
    }
    msgs = trimHistory(msgs);

    var maxTokens = Number(state.prefs.maxTokens) || 2048;
    var temp = Number(state.prefs.temperature);
    if (isNaN(temp)) temp = 1;
    var sys = composedSystem();
    var effort = currentEffort().key;

    if (prov.protocol === 'anthropic') {
      var body = {
        model: prof.model,
        max_tokens: maxTokens,
        temperature: temp,
        messages: msgs,
        stream: true
      };
      if (sys) body.system = sys;

      if (prov.reasoning === 'anthropic') {
        var budget = ANTHROPIC_BUDGET[effort] || 0;
        if (budget > 0) {
          body.thinking = { type: 'enabled', budget_tokens: budget };
          // 开启思考时 Anthropic 只接受 temperature = 1，直接不发这个字段
          delete body.temperature;
          body.max_tokens = Math.max(maxTokens, budget + 1024, 2048);
        }
      }

      return {
        url: base + '/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': prof.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: body,
        model: prof.model,
        effort: effort
      };
    }

    var oaMsgs = sys ? [{ role: 'system', content: sys }].concat(msgs) : msgs;
    var oaBody = {
      model: prof.model,
      messages: oaMsgs,
      stream: true,
      temperature: temp,
      max_tokens: maxTokens
    };

    if (prov.reasoning === 'deepseek') {
      var dv = DEEPSEEK_EFFORT[effort];
      if (dv) oaBody.reasoning_effort = dv;
    } else if (prov.reasoning === 'openai') {
      var ov = OPENAI_EFFORT[effort];
      if (ov) oaBody.reasoning_effort = ov;
    } else if (prov.reasoning === 'zhipu') {
      var zv = ZHIPU_EFFORT[effort];
      if (zv) {
        oaBody.reasoning_effort = zv;
        oaBody.thinking = { type: 'enabled' };
      }
    }

    return {
      url: base + '/chat/completions',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + prof.apiKey
      },
      body: oaBody,
      model: prof.model,
      effort: effort
    };
  }

  function handleOpenAIChunk(j, cb) {
    if (!j) return;
    if (j.error) {
      throw new ApiError((j.error && j.error.code) || 400, (j.error && j.error.message) || '服务商返回错误');
    }
    var choice = j.choices && j.choices[0];
    if (!choice) return;
    var d = choice.delta || choice.message || {};
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) cb.onThink(d.reasoning_content);
    else if (typeof d.reasoning === 'string' && d.reasoning) cb.onThink(d.reasoning);
    if (typeof d.content === 'string' && d.content) cb.onText(d.content);
  }

  function handleAnthropicChunk(j, cb) {
    if (!j) return;
    if (j.type === 'error') throw new ApiError(400, (j.error && j.error.message) || '服务商返回错误');
    if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta' && j.delta.text) cb.onText(j.delta.text);
      else if (j.delta.type === 'thinking_delta' && j.delta.thinking) cb.onThink(j.delta.thinking);
    }
  }

  async function readStream(stream, protocol, cb) {
    var reader = stream.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    var done = false;
    while (!done) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { done = true; break; }
        var j;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        if (protocol === 'anthropic') handleAnthropicChunk(j, cb);
        else handleOpenAIChunk(j, cb);
      }
    }
    try { reader.cancel(); } catch (e) { /* 忽略 */ }
  }

  function setBusy(busy) {
    state.streaming = busy;
    var btn = el.btnSend;
    btn.classList.toggle('stop', busy);
    btn.setAttribute('aria-label', busy ? t('tool.stop') : t('tool.send'));
    btn.innerHTML = busy
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  }

  function stopGeneration() {
    if (state.controller) state.controller.abort();
  }

  /* 这个错误值不值得改用原生请求重试：浏览器跨域/网络失败，且服务商本来就不给 CORS 头 */
  function shouldTryNative(err, prov) {
    if (!isNative || !Native.NativeHttp.hasPlugin()) return false;
    if (err && err.name === 'AbortError') return false;
    if (err && err.name === 'ApiError') return false;   // 服务商真的报错了，重试也一样
    return !!(prov && prov.browserBlocked);
  }

  /* 从完整 JSON 里抠出正文和思考过程（非流式） */
  function extractFull(j, protocol) {
    var out = { text: '', think: '' };
    if (!j) return out;
    if (protocol === 'anthropic') {
      var blocks = j.content || [];
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (!b || !b.type) continue;
        if (b.type === 'text') out.text += b.text || '';
        else if (b.type === 'thinking') out.think += b.thinking || '';
      }
      return out;
    }
    var choice = (j.choices && j.choices[0]) || {};
    var m = choice.message || choice.delta || {};
    out.text = typeof m.content === 'string' ? m.content : '';
    out.think = m.reasoning_content || m.reasoning || '';
    return out;
  }

  async function startGeneration(node, botMsg, history, idx) {
    var bodyEl = node.querySelector('.msg-body');
    var ac = new AbortController();
    state.controller = ac;
    state.pinned = true;
    setBusy(true);
    node.dataset.streaming = 'true';

    var pending = false;
    function paint() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        var atBottom = state.pinned;
        bodyEl.innerHTML = mdToHtml(botMsg.content || '');
        ensureReasoning(node, botMsg);
        if (atBottom) autoScroll(true);
      });
    }

    var req = null;
    var protocol = 'openai';
    try {
      req = buildRequest(history);
      protocol = profileProvider(activeProfile()).protocol;

      try {
        var res = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: ac.signal
        });
        if (!res.ok) {
          var raw = await res.text();
          throw new ApiError(res.status, pickServerMessage(raw), raw);
        }
        if (!res.body) throw new Error(t('err.noStream'));

        await readStream(res.body, protocol, {
          onText: function (chunk) { botMsg.content += chunk; paint(); },
          onThink: function (chunk) {
            botMsg.reasoning = (botMsg.reasoning || '') + chunk;
            if (!botMsg.content) paint();
            else ensureReasoning(node, botMsg);
          }
        });
      } catch (inner) {
        /* App 里遇到不允许跨域的服务商：改走原生请求（会丢掉流式） */
        if (!shouldTryNative(inner, profileProvider(activeProfile()))) throw inner;

        var body = {}; for (var k in req.body) if (Object.prototype.hasOwnProperty.call(req.body, k)) body[k] = req.body[k];
        body.stream = false;
        var nr = await Native.NativeHttp.request(req.url, req.headers, body);
        if (!nr) throw inner;
        if (!nr.ok) throw new ApiError(nr.status, pickServerMessage(nr.text), nr.text);
        var parsed;
        try { parsed = JSON.parse(nr.text); } catch (e) { throw inner; }
        var full = extractFull(parsed, protocol);
        if (full.think) botMsg.reasoning = full.think;
        botMsg.content = full.text;
        botMsg.noStream = true;
        paint();
      }

      if (!botMsg.content && !botMsg.reasoning) {
        botMsg.content = t('err.empty');
        node.dataset.error = 'true';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (!botMsg.content) botMsg.content = t('common.stopped');
        else botMsg.content += '\n\n' + t('common.stopped');
      } else {
        botMsg.content = errorText(err);
        node.dataset.error = 'true';
      }
    } finally {
      delete node.dataset.streaming;
      bodyEl.innerHTML = mdToHtml(botMsg.content || '');
      if (botMsg.noStream) {
        var note = document.createElement('p');
        note.className = 'no-stream-note';
        note.textContent = t('effort.nativeNote');
        node.appendChild(note);
      }
      ensureReasoning(node, botMsg);
      state.controller = null;
      setBusy(false);
      setActions(node, botMsg, idx);
      persistNow();
      autoScroll(false);
    }
  }

  function ensureReasoning(node, msg) {
    if (!msg.reasoning) return;
    var box = node.querySelector('.reasoning');
    if (!box) {
      box = reasoningBlock(msg);
      var head = node.querySelector('.msg-head');
      if (head && head.nextSibling) node.insertBefore(box, head.nextSibling);
      else node.appendChild(box);
    }
    var body = box.querySelector('.think-body');
    if (body) body.textContent = msg.reasoning;
    if (node.dataset.streaming === 'true' && msg.content) box.open = false;
  }

  function send() {
    if (state.streaming) return;
    var text = el.input.value.trim();
    if (!text && !state.attachments.length) return;

    var prof = activeProfile();
    if (!prof) { openSettings('keys'); openProfileForm(''); toast(t('toast.needKeyFirst')); return; }
    if (!prof.apiKey) { openSettings('keys'); toast(t('toast.needKeyField')); return; }
    if (!prof.model) { openSettings('keys'); toast(t('toast.needModel')); return; }
    if (!state.conv) newConv();

    var conv = state.conv;
    var atts = state.attachments.slice();
    var userMsg = { role: 'user', content: text, at: Date.now() };
    if (atts.length) userMsg.attachments = atts;
    conv.messages.push(userMsg);
    appendNode(msgNode(userMsg, conv.messages.length - 1));
    maybeRetitle(text);
    clearAttachments();

    var history = conv.messages.slice();
    var idx = conv.messages.length;
    var skillNames = enabledSkills().map(function (s) { return s.name; });
    var botMsg = {
      role: 'assistant', content: '', model: prof.model, at: Date.now(),
      skills: skillNames.length ? skillNames : null,
      effort: t(currentEffort().nameKey)
    };
    conv.messages.push(botMsg);
    conv.model = prof.model;

    var node = msgNode(botMsg, idx);
    appendNode(node);

    el.input.value = '';
    autoGrow();
    persist();
    startGeneration(node, botMsg, history, idx);
  }

  function regenerate() {
    if (state.streaming || !state.conv) return;
    var conv = state.conv;
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') {
      conv.messages.pop();
    }
    if (!conv.messages.length) return;
    renderStream();
    var prof = activeProfile();
    var idx = conv.messages.length;
    var skillNames = enabledSkills().map(function (s) { return s.name; });
    var botMsg = {
      role: 'assistant', content: '', model: prof ? prof.model : '', at: Date.now(),
      skills: skillNames.length ? skillNames : null,
      effort: t(currentEffort().nameKey)
    };
    var history = conv.messages.slice();
    conv.messages.push(botMsg);
    var node = msgNode(botMsg, idx);
    appendNode(node);
    persist();
    startGeneration(node, botMsg, history, idx);
  }

  /* ---------- 面板 ---------- */

  function setPanel(panel, open) {
    panel.dataset.open = open ? 'true' : 'false';
    if ('inert' in panel) panel.inert = !open;
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    var anyOpen = el.drawer.dataset.open === 'true' ||
      el.settings.dataset.open === 'true' ||
      el.skills.dataset.open === 'true';
    el.scrim.dataset.open = anyOpen ? 'true' : 'false';
  }

  function openDrawer() { renderConvList(); setPanel(el.drawer, true); }
  function closeDrawer() { setPanel(el.drawer, false); }

  /* ---------- 设置（分类页签） ---------- */

  function renderTabs() {
    var tabs = el.settingsTabs.querySelectorAll('[data-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.tab === state.settingsTab;
      tabs[i].dataset.on = on ? 'true' : 'false';
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panes = el.settings.querySelectorAll('[data-pane]');
    for (var j = 0; j < panes.length; j++) {
      panes[j].hidden = panes[j].dataset.pane !== state.settingsTab;
    }
  }

  function setSettingsTab(name) {
    state.settingsTab = name || 'keys';
    renderTabs();
    el.settings.querySelector('.sheet-body').scrollTop = 0;
  }

  function renderChangelog() {
    if (!el.changelog) return;
    var lang = I18N.getLang() === 'en' ? 'en' : 'zh';
    var html = '';
    for (var i = 0; i < CHANGELOG.length; i++) {
      var item = CHANGELOG[i];
      var lines = item[lang] || item.zh || [];
      html += '<div class="cl-item">' +
        '<div class="cl-head"><span class="cl-ver">' + esc(item.v) + '</span>' +
        '<span class="cl-date">' + esc(item.date) + '</span></div>' +
        '<ul class="cl-list">';
      for (var j = 0; j < lines.length; j++) {
        html += '<li>' + esc(lines[j]) + '</li>';
      }
      html += '</ul></div>';
    }
    el.changelog.innerHTML = html;
  }

  function fillSettingsForm() {
    renderProfileList();
    if (el.profileForm.hidden && !state.profiles.length) {
      /* 第一次用、还没有密钥时直接把新增表单摊开，省一次点击 */
      openProfileForm('');
    }
    fillPrefsForm();
    renderChangelog();
    if (el.appVersion) el.appVersion.textContent = APP_VERSION;
    renderSecureNote();
  }

  function openSettings(tab) {
    closeDrawer();
    fillSettingsForm();
    setSettingsTab(tab || state.settingsTab || 'keys');
    setPanel(el.settings, true);
  }

  function closeSettings() {
    setPanel(el.settings, false);
    closeProfileForm();
  }

  function openSkills() {
    closeDrawer();
    renderSkillList();
    setPanel(el.skills, true);
  }

  function closeSkills() {
    setPanel(el.skills, false);
    closeSkillForm();
  }

  /* 切换界面语言：静态节点刷一遍，动态内容重新渲染 */
  function applyLanguage(lang, silent) {
    var chosen = I18N.setLang(lang);
    state.prefs.lang = chosen;
    savePrefs();
    I18N.applyI18n(document);
    document.title = t('app.name') + ' · ' + t('app.tagline');
    renderTitle();
    renderHint();
    renderEmpty();
    renderConvList();
    renderProfileList();
    renderSkillList();
    renderPaletteList();
    renderLangList();
    renderChangelog();
    renderSampleChips();
    renderCtx();
    if (el.profileForm && !el.profileForm.hidden) {
      el.profileFormTitle.textContent = state.editingProfileId ? t('keys.editTitle') : t('keys.addTitle');
      el.btnPfToggleKey.textContent = el.pfKey.type === 'text' ? t('keys.hide') : t('keys.show');
      el.btnPfFetch.textContent = t('keys.fetch');
      onProfileProviderChange(true);
    }
    if (el.skillForm && !el.skillForm.hidden) {
      el.skillFormTitle.textContent = state.editingSkillId ? t('skills.editTitle') : t('skills.addTitle');
    }
    setBusy(state.streaming);
    if (!silent) toast(t('lang.switched'));
  }

  /* ---------- 导入导出 ---------- */

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  }

  function exportAll() {
    persistNow();
    var payload = Store.dumpAll();
    if (!payload.conversations.length) { toast(t('toast.nothingToExport')); return; }
    download('keyapp-backup-' + stamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast(t('toast.exported', { n: payload.conversations.length }));
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var payload = JSON.parse(String(reader.result));
        var n = Store.importAll(payload);
        state.index = Store.loadIndex();
        renderConvList();
        toast(n ? t('toast.imported', { n: n }) : t('toast.importNone'));
      } catch (e) {
        toast(t('toast.importFail'), 4000);
      }
    };
    reader.readAsText(file);
  }

  function exportConvMarkdown(id) {
    var conv = Store.loadConv(id);
    if (!conv) return;
    var lines = ['# ' + (conv.title || '对话'), '',
      '模型：' + (conv.model || '未知') + '　时间：' + new Date(conv.updatedAt || Date.now()).toLocaleString(), ''];
    for (var i = 0; i < (conv.messages || []).length; i++) {
      var m = conv.messages[i];
      lines.push('## ' + (m.role === 'user' ? '你' : (m.model || 'AI')));
      if (m.skills && m.skills.length) lines.push('', '_技能：' + m.skills.join('、') + '_');
      if (m.effort) lines.push('', '_强度：' + m.effort + '_');
      if (m.reasoning) {
        lines.push('', '> 思考过程', '');
        lines.push(m.reasoning.split('\n').map(function (l) { return '> ' + l; }).join('\n'));
      }
      lines.push('', m.content || '', '');
    }
    download((conv.title || '对话').replace(/[\\/:*?"<>|]/g, '_') + '.md', lines.join('\n'), 'text/markdown;charset=utf-8');
    toast(t('toast.mdExported'));
  }

  /* ---------- 输入框 ---------- */

  function autoGrow() {
    var t = el.input;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 150) + 'px';
  }

  function isCoarsePointer() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  /* ---------- 弹出层 ---------- */

  function closePops() {
    if (el.effortPop) el.effortPop.hidden = true;
    if (el.moreMenu) el.moreMenu.hidden = true;
    if (el.btnEffort) el.btnEffort.setAttribute('aria-expanded', 'false');
    if (el.btnMore) el.btnMore.setAttribute('aria-expanded', 'false');
  }

  function togglePop(pop, btn) {
    var opening = pop.hidden;
    closePops();
    if (opening) {
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  /* ---------- 语音输入 ---------- */

  var recog = null;

  function toggleMic() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast(t('toast.micUnsupported'), 4000);
      return;
    }
    if (recog) {
      recog.stop();
      return;
    }
    try {
      recog = new SR();
    } catch (e) {
      toast(t('toast.micFail'), 3000);
      return;
    }
    var base = el.input.value;
    recog.lang = 'zh-CN';
    recog.continuous = true;
    recog.interimResults = true;
    recog.onresult = function (ev) {
      var txt = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      el.input.value = base ? base + ' ' + txt : txt;
      autoGrow();
    };
    recog.onerror = function () {
      toast(t('toast.micError'), 4000);
    };
    recog.onend = function () {
      recog = null;
      el.btnMic.classList.remove('recording');
      el.btnMic.setAttribute('aria-label', '语音输入');
    };
    el.btnMic.classList.add('recording');
    el.btnMic.setAttribute('aria-label', '停止录音');
    try {
      recog.start();
      toast(t('toast.micListening'), 2400);
    } catch (e) {
      toast(t('toast.micFail'), 3000);
      recog = null;
      el.btnMic.classList.remove('recording');
    }
  }

  /* ---------- 事件 ---------- */

  function bindEvents() {
    el.btnMenu.addEventListener('click', openDrawer);
    el.btnCloseDrawer.addEventListener('click', closeDrawer);
    el.scrim.addEventListener('click', function () { closeDrawer(); closeSettings(); closeSkills(); });
    el.btnNew.addEventListener('click', function () {
      closeDrawer();
      leaveTempIfNeeded(function () {
        newConv();
        el.input.focus();
      });
    });
    el.btnTemp.addEventListener('click', toggleTemp);
    el.btnSaveTemp.addEventListener('click', saveTempConv);
    el.btnSettings2.addEventListener('click', function () { closeDrawer(); openSettings('keys'); });
    el.btnModel.addEventListener('click', function () { closePops(); openSettings('keys'); });
    el.btnSkillIcon.addEventListener('click', function () { closePops(); openSkills(); });
    el.btnSkills2.addEventListener('click', openSkills);

    el.btnEffort.addEventListener('click', function () { togglePop(el.effortPop, el.btnEffort); });
    el.btnMore.addEventListener('click', function () { togglePop(el.moreMenu, el.btnMore); });
    el.btnMic.addEventListener('click', toggleMic);

    el.moreMenu.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      var act = btn && btn.dataset ? btn.dataset.act : null;
      if (!act) return;
      closePops();
      if (act === 'pick-image') el.pickImages.click();
      else if (act === 'pick-file') el.pickFiles.click();
      else if (act === 'drawer') openDrawer();
      else if (act === 'import') el.fileImport.click();
      else if (act === 'export') exportAll();
      else if (act === 'save-temp') saveTempConv();
    });

    el.pickImages.addEventListener('change', function () {
      addImageFiles(el.pickImages.files);
      el.pickImages.value = '';
    });
    el.pickFiles.addEventListener('change', function () {
      addTextFiles(el.pickFiles.files);
      el.pickFiles.value = '';
    });

    document.addEventListener('pointerdown', function (e) {
      if (!el.effortPop || el.effortPop.hidden) {
        if (!el.moreMenu || el.moreMenu.hidden) return;
      }
      var t = e.target;
      if (el.effortPop.contains(t) || el.moreMenu.contains(t)) return;
      if (el.btnEffort.contains(t) || el.btnMore.contains(t)) return;
      closePops();
    });

    el.btnSend.addEventListener('click', function () {
      if (state.streaming) stopGeneration();
      else send();
    });

    el.input.addEventListener('input', autoGrow);

    /* 粘图（桌面端 Ctrl+V）与拖放 */
    el.input.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); addImageFiles(files); }
    });

    ['dragover', 'drop'].forEach(function (ev) {
      el.composerBox.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev !== 'drop' || !e.dataTransfer || !e.dataTransfer.files.length) return;
        var fs = Array.prototype.slice.call(e.dataTransfer.files);
        var imgs = fs.filter(function (f) { return /^image\//.test(f.type); });
        var rest = fs.filter(function (f) { return !/^image\//.test(f.type); });
        if (imgs.length) addImageFiles(imgs);
        if (rest.length) addTextFiles(rest);
      });
    });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isCoarsePointer()) {
        e.preventDefault();
        send();
      }
    });

    el.stream.addEventListener('scroll', onStreamScroll, { passive: true });

    el.emptyState.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.dataset) return;
      if (t.dataset.act === 'open-keys') { openSettings('keys'); return; }
      if (t.dataset.act === 'open-skills') { openSkills(); return; }
      if (t.dataset.fill) {
        el.input.value = t.dataset.fill;
        autoGrow();
        el.input.focus();
      }
    });

    el.convList.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.dataset.del) { removeConv(t.dataset.del); return; }
      if (t.dataset.md) { exportConvMarkdown(t.dataset.md); return; }
      if (t.classList.contains('conv-open')) {
        closeDrawer();
        if (!state.conv || state.conv.id !== t.dataset.id) {
          leaveTempIfNeeded(function () { openConv(t.dataset.id); });
        }
      }
    });

    var pressTimer = 0;
    el.convList.addEventListener('pointerdown', function (e) {
      var open = e.target.closest ? e.target.closest('.conv-open') : null;
      if (!open) return;
      pressTimer = setTimeout(function () { renameConv(open.dataset.id); }, 620);
    }, { passive: true });
    ['pointerup', 'pointercancel', 'pointermove'].forEach(function (ev) {
      el.convList.addEventListener(ev, function () { clearTimeout(pressTimer); }, { passive: true });
    });

    /* 密钥列表 */
    el.profileList.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.dataset.del) { deleteProfile(t.dataset.del); return; }
      if (t.dataset.edit) { openProfileForm(t.dataset.edit); return; }
      if (t.dataset.activate) {
        if (t.dataset.activate === state.activeId) { openProfileForm(t.dataset.activate); return; }
        setActiveProfile(t.dataset.activate);
        toast(t('toast.switched'));
      }
    });

    el.btnAddProfile.addEventListener('click', function () { openProfileForm(''); });
    el.btnPfCancel.addEventListener('click', closeProfileForm);
    el.btnPfSave.addEventListener('click', saveProfileForm);
    el.pfProvider.addEventListener('change', function () { onProfileProviderChange(false); });
    el.btnPfToggleKey.addEventListener('click', function () {
      var showing = el.pfKey.type === 'text';
      el.pfKey.type = showing ? 'password' : 'text';
      el.btnPfToggleKey.textContent = showing ? t('keys.show') : t('keys.hide');
    });
    el.btnPfFetch.addEventListener('click', fetchModelList);

    /* 强度滑条 */
    el.effortRange.addEventListener('input', function () {
      setEffort(Number(el.effortRange.value));
    });
    /* 技能列表 */
    el.skillList.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.dataset.toggle) { toggleSkill(t.dataset.toggle); return; }
      if (t.dataset.sdel) { deleteSkill(t.dataset.sdel); return; }
      if (t.dataset.sedit) { openSkillForm(t.dataset.sedit); return; }
    });
    el.btnAddSkill.addEventListener('click', function () { openSkillForm(''); });
    el.btnSfCancel.addEventListener('click', closeSkillForm);
    el.btnSfSave.addEventListener('click', saveSkillForm);
    el.skillSamples.addEventListener('click', function (e) {
      var idx = e.target.dataset ? e.target.dataset.sample : null;
      if (idx == null) return;
      var s = SKILL_SAMPLES[Number(idx)];
      if (!s) return;
      var en = I18N.getLang() === 'en';
      el.sfName.value = en ? (s.nameEn || s.name) : s.name;
      el.sfHint.value = en ? (s.hintEn || s.hint) : s.hint;
      el.sfBody.value = en ? (s.bodyEn || s.body) : s.body;
      el.sfName.focus();
    });

    /* 设置页签 */
    el.settingsTabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-tab]') : null;
      if (!b) return;
      setSettingsTab(b.dataset.tab);
    });

    /* 语言 */
    el.langList.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-lang]') : null;
      if (!b) return;
      if (b.dataset.lang === I18N.getLang()) return;
      applyLanguage(b.dataset.lang, false);
    });

    /* 偏好 */
    el.fTemp.addEventListener('input', function () {
      el.tempVal.textContent = Number(el.fTemp.value).toFixed(1);
    });

    el.paletteList.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-pal]') : null;
      if (!b) return;
      state.prefs.palette = b.dataset.pal;
      if (b.dataset.pal === 'custom') {
        el.fAccent.value = state.prefs.customAccent || '#2E7BD6';
        el.fBg.value = state.prefs.customBg || '#F2F8FF';
      }
      savePrefs();
      applyTheme();
      renderPaletteList();
    });

    el.fAccent.addEventListener('input', function () {
      state.prefs.customAccent = el.fAccent.value;
      state.prefs.palette = 'custom';
      savePrefs();
      applyTheme();
      renderPaletteList();
    });

    el.fBg.addEventListener('input', function () {
      state.prefs.customBg = el.fBg.value;
      state.prefs.palette = 'custom';
      savePrefs();
      applyTheme();
      renderPaletteList();
    });
    el.fTheme.addEventListener('change', function () {
      state.prefs.theme = el.fTheme.value;
      savePrefs();
      applyTheme();
    });

    el.fSystem.addEventListener('input', function () {
      state.prefs.systemPrompt = el.fSystem.value;
      savePrefs();
    });

    el.fMax.addEventListener('input', function () {
      state.prefs.maxTokens = Number(el.fMax.value) || 2048;
      savePrefs();
    });

    el.fTemp.addEventListener('change', function () {
      state.prefs.temperature = Number(el.fTemp.value);
      savePrefs();
    });

    el.btnCloseSettings.addEventListener('click', closeSettings);
    el.btnCloseSkills.addEventListener('click', closeSkills);

    el.btnClearKeys.addEventListener('click', function () {
      if (!state.profiles.length) { toast(t('keys.empty')); return; }
      if (!window.confirm(t('keys.clearAllAsk', { n: state.profiles.length }))) return;
      state.profiles = [];
      state.activeId = '';
      saveProfiles();
      Store.saveActiveProfile('');
      closeProfileForm();
      renderProfileList();
      renderHint();
      renderEmpty();
      openProfileForm('');
      toast(t('toast.deleted'));
    });

    el.btnExportAll.addEventListener('click', exportAll);
    el.btnImport.addEventListener('click', function () { el.fileImport.click(); });
    el.fileImport.addEventListener('change', function () {
      var f = el.fileImport.files && el.fileImport.files[0];
      if (f) importFile(f);
      el.fileImport.value = '';
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrawer(); closeSettings(); closeSkills(); }
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var handler = function () { if (state.prefs.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
    }

    window.addEventListener('beforeunload', function () { persistNow(); });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // 打包成 App 后资源已经在本地包里，再挂一层缓存反而会让更新不生效
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;
    var p = location.protocol;
    var host = location.hostname;
    if (p !== 'https:' && host !== 'localhost' && host !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').catch(function () { /* 离线缓存没装上不影响使用 */ });
  }

  function cacheDom() {
    el.stream = $('stream');
    el.emptyState = $('emptyState');
    el.input = $('input');
    el.btnSend = $('btnSend');
    el.btnNew = $('btnNew');
    el.btnMenu = $('btnMenu');
    el.convTitle = $('convTitle');
    el.modelName = $('modelName');
    el.btnModel = $('btnModel');
    el.btnTemp = $('btnTemp');
    el.btnSaveTemp = $('btnSaveTemp');
    el.btnSettings2 = $('btnSettings2');
    el.menuSaveTemp = $('menuSaveTemp');
    el.settingsTabs = $('settingsTabs');
    el.langList = $('langList');
    el.changelog = $('changelog');
    el.appVersion = $('appVersion');
    el.secureNote = $('secureNote');
    el.secureNote2 = $('secureNote2');
    el.btnSkillIcon = $('btnSkillIcon');
    el.skillBadge = $('skillBadge');
    el.btnMore = $('btnMore');
    el.moreMenu = $('moreMenu');
    el.pickImages = $('pickImages');
    el.pickFiles = $('pickFiles');
    el.attachStrip = $('attachStrip');
    el.composerBox = $('composerBox');
    el.paletteList = $('paletteList');
    el.paletteCustom = $('paletteCustom');
    el.fAccent = $('fAccent');
    el.fBg = $('fBg');
    el.statusLine = $('statusLine');
    el.btnMic = $('btnMic');
    el.ctxRing = $('ctxRing');
    el.ctxBar = $('ctxBar');
    el.drawer = $('drawer');
    el.convList = $('convList');
    el.btnCloseDrawer = $('btnCloseDrawer');
    el.btnSkills2 = $('btnSkills2');
    el.btnExportAll = $('btnExportAll');
    el.btnImport = $('btnImport');
    el.fileImport = $('fileImport');
    el.scrim = $('scrim');

    el.settings = $('settings');
    el.profileList = $('profileList');
    el.btnAddProfile = $('btnAddProfile');
    el.profileForm = $('profileForm');
    el.profileFormTitle = $('profileFormTitle');
    el.pfLabel = $('pfLabel');
    el.pfProvider = $('pfProvider');
    el.pfProviderNote = $('pfProviderNote');
    el.pfBase = $('pfBase');
    el.pfKey = $('pfKey');
    el.btnPfToggleKey = $('btnPfToggleKey');
    el.pfModel = $('pfModel');
    el.pfModelOptions = $('pfModelOptions');
    el.btnPfFetch = $('btnPfFetch');
    el.effortRange = $('effortRange');
    el.effortName = $('effortName');
    el.effortPopName = $('effortPopName');
    el.effortNote = $('effortNote');
    el.effortPop = $('effortPop');
    el.btnEffort = $('btnEffort');
    el.effortTicksLabels = $('effortTicksLabels');
    el.btnPfSave = $('btnPfSave');
    el.btnPfCancel = $('btnPfCancel');
    el.fSystem = $('fSystem');
    el.fTemp = $('fTemp');
    el.tempVal = $('tempVal');
    el.fMax = $('fMax');
    el.fTheme = $('fTheme');
    el.btnCloseSettings = $('btnCloseSettings');
    el.btnClearKeys = $('btnClearKeys');

    el.skills = $('skills');
    el.skillList = $('skillList');
    el.btnAddSkill = $('btnAddSkill');
    el.skillForm = $('skillForm');
    el.skillFormTitle = $('skillFormTitle');
    el.sfName = $('sfName');
    el.sfHint = $('sfHint');
    el.sfBody = $('sfBody');
    el.skillSamples = $('skillSamples');
    el.btnSfSave = $('btnSfSave');
    el.btnSfCancel = $('btnSfCancel');
    el.btnCloseSkills = $('btnCloseSkills');

    el.toast = $('toast');
  }

  function init() {
    cacheDom();
    loadPrefs();

    /* 语言要在渲染任何文字之前定下来 */
    I18N.setLang(state.prefs.lang || 'zh');
    I18N.applyI18n(document);
    document.title = t('app.name') + ' · ' + t('app.tagline');
    applyTheme();

    state.profiles = Store.loadProfiles();
    state.activeId = Store.loadActiveProfile();
    state.skills = Store.loadSkills();
    migrateLegacy();
    if (!state.activeId && state.profiles.length) state.activeId = state.profiles[0].id;
    if (state.activeId && !activeProfile()) {
      state.activeId = state.profiles.length ? state.profiles[0].id : '';
    }

    state.index = Store.loadIndex();
    bindEvents();

    if (state.index.length) {
      var first = Store.loadConv(state.index[0].id);
      if (first) {
        state.conv = first;
        if (!Array.isArray(first.messages)) first.messages = [];
        renderStream();
        renderTitle();
      } else {
        newConv();
      }
    } else {
      newConv();
    }

    renderProfileList();
    renderSkillList();
    renderEmpty();
    renderHint();
    renderConvList();
    populateProfileProvider();
    setPanel(el.drawer, false);
    setPanel(el.settings, false);
    setPanel(el.skills, false);
    setBusy(false);
    renderEffort();
    renderTabs();
    renderChangelog();
    if (el.appVersion) el.appVersion.textContent = APP_VERSION;
    registerSW();

    /* 提示条要始终浮在输入区上方，随输入区高度变化 */
    if (window.ResizeObserver && el.composerBox) {
      var syncH = function () {
        document.documentElement.style.setProperty(
          '--composer-h', el.composerBox.offsetHeight + 'px');
      };
      new ResizeObserver(syncH).observe(el.composerBox);
      syncH();
    }

    /* 数据升级：只补不删；密钥加密成功才会删掉明文副本 */
    Promise.resolve(Store.migrate()).then(function (r) {
      if (!r) return;
      state.profiles = Store.loadProfiles();
      state.secureOn = Store.usesSecureProfiles() || (typeof Native !== 'undefined' && Native.SecureStore.isAvailable());
      if (r.done.indexOf('encrypted-keys') >= 0) toast(t('toast.secureMigrated'), 4000);
      renderProfileList();
      renderHint();
      renderSecureNote();
    }).catch(function () { /* 迁移失败就维持原样，不动数据 */ });

    /* 加密存储可用性（只用于界面提示） */
    if (typeof Native !== 'undefined' && Native.SecureStore.isNative) {
      Promise.resolve(Native.SecureStore.check()).then(function (avail) {
        state.secureOn = !!avail;
        renderSecureNote();
      });
    }

    if (!Store.isPersistent()) {
      toast(t('toast.storageWarn'), 9000);
    } else if (!state.profiles.length) {
      setTimeout(function () { openSettings('keys'); }, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
