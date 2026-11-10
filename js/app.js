/* 钥匙 · 自带 API Key 的 AI 对话客户端
   纯前端：请求从浏览器直接发往服务商，对话记录写在本机 localStorage。 */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */

  var DEFAULT_PREFS = {
    temperature: 1, maxTokens: 2048, systemPrompt: '', theme: 'dark', intensity: 2,
    palette: 'brass', customAccent: '#D8A25C', customBg: '#0F1613'
  };

  /* 配色方案：accent 为强调色，bg 为底色；每套分别给深/浅两版 */
  var PALETTES = [
    { id: 'brass', name: '黄铜', accent: '#D8A25C', accentLight: '#A9691F', bg: '#0F1613', bgLight: '#F1F3F0' },
    { id: 'jade', name: '青瓷', accent: '#6FB9A0', accentLight: '#27745F', bg: '#0C1614', bgLight: '#EFF4F1' },
    { id: 'ink', name: '石墨', accent: '#9FB3C8', accentLight: '#3C5872', bg: '#0D0F11', bgLight: '#F0F2F4' },
    { id: 'wine', name: '绛紫', accent: '#C98FA6', accentLight: '#8E3F5C', bg: '#150E13', bgLight: '#F5EFF2' },
    { id: 'ember', name: '赤陶', accent: '#E08A5B', accentLight: '#A9502A', bg: '#161010', bgLight: '#F5F0EC' },
    { id: 'custom', name: '自定义', accent: null, bg: null, bgLight: null }
  ];

  /* 思考强度：5 档，各自向服务商的能力映射（见 buildRequest） */
  var EFFORT = [
    { key: 'off', name: '关闭' },
    { key: 'low', name: '低' },
    { key: 'mid', name: '中' },
    { key: 'high', name: '高' },
    { key: 'max', name: '无限制' }
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
      name: '翻译成英式英语',
      hint: '写论文、改句子时',
      body: '把用户给出的内容翻译成英式英语（British English），保留原文段落结构，用词和拼写遵循英式规范，不要额外解释。'
    },
    {
      name: '先给结论',
      hint: '需要快速判断时',
      body: '先用一句话给出结论，再展开理由。理由是分点的，每点不超过两行。不要写开场客套话。'
    },
    {
      name: '代码要能跑',
      hint: '写代码、改 bug 时',
      body: '给代码时给出完整可运行的文件内容，标出文件路径。改动用注释标出原因。不要省略成省略号。'
    },
    {
      name: '只要中文',
      hint: '中文环境',
      body: '始终用简体中文回答，专有名词保留英文原文并加括号注明。'
    }
  ];

  /* ---------- 状态 ---------- */

  var state = {
    prefs: null,        // temperature / maxTokens / systemPrompt / theme
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
    sheetBeforeProfile: 'deepseek'
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
        function () { toast('已复制'); },
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
    try { document.execCommand('copy'); toast('已复制'); }
    catch (e) { toast('复制失败，请手动选中'); }
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
    if (!p) return '未选择密钥';
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
    if (!Store.saveProfiles(state.profiles)) {
      toast('密钥没能存进本机：存储可能已满或被浏览器禁止。', 5000);
    }
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
      none.textContent = '还没有密钥。点右上角「新增」加第一条。';
      box.appendChild(none);
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
      var keyTail = p.apiKey ? '••••' + esc(p.apiKey.slice(-4)) : '未填 Key';
      main.innerHTML =
        '<span class="prow-name">' + esc(profileLabel(p)) + (p.id === state.activeId ? '<span class="prow-flag">在用</span>' : '') + '</span>' +
        '<span class="prow-meta">' + esc(prov.name) + ' · ' + esc(p.model || '未选模型') + ' · ' + keyTail + '</span>';
      row.appendChild(main);

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini-btn';
      edit.dataset.edit = p.id;
      edit.textContent = '改';
      edit.setAttribute('aria-label', '编辑这条密钥');
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
    el.profileFormTitle.textContent = p ? '编辑密钥' : '新增密钥';
    el.profileForm.hidden = false;

    populateProfileProvider(p ? p.providerId : (state.sheetBeforeProfile || 'deepseek'));
    el.pfLabel.value = p ? (p.label || '') : '';
    el.pfBase.value = p ? (p.baseUrl || '') : (profileProvider({ providerId: el.pfProvider.value }).baseUrl || '');
    el.pfKey.value = p ? (p.apiKey || '') : '';
    el.pfModel.value = p ? (p.model || '') : '';
    el.pfKey.type = 'password';
    el.btnPfToggleKey.textContent = '显示';
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
    if (p.browserBlocked && !isNative) bits.push('⚠ 这家不返回跨域允许头，纯网页直连会被拦下；打包成 App 后可以正常用。');
    if (p.keyUrl) bits.push('拿 Key：' + p.keyUrl);
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

    if (!apiKey) { toast('API Key 不能是空的'); el.pfKey.focus(); return; }
    if (!baseUrl && !prov.baseUrl) { toast('接口地址不能是空的'); el.pfBase.focus(); return; }
    if (!model) { toast('填一个默认模型名'); el.pfModel.focus(); return; }
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
    toast(wasEditing ? '已保存' : '已添加「' + label + '」');
  }

  function deleteProfile(id) {
    var p = null;
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === id) { p = state.profiles[i]; break; }
    }
    if (!p) return;
    if (!window.confirm('删除「' + profileLabel(p) + '」这条密钥？删掉要重新填。')) return;
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
    toast('已删除');
  }

  async function fetchModelList() {
    var prov = getProvider(el.pfProvider.value);
    var base = (el.pfBase.value.trim() || prov.baseUrl || '').replace(/\/+$/, '');
    var key = el.pfKey.value.trim();
    if (!base) { toast('先填接口地址'); return; }
    if (!key) { toast('先填 API Key'); return; }

    el.btnPfFetch.disabled = true;
    el.btnPfFetch.textContent = '拉取中';
    try {
      var headers = { 'authorization': 'Bearer ' + key };
      if (prov.protocol === 'anthropic') {
        headers = {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        };
      }
      var res = await fetch(base + '/models', { headers: headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var j = await res.json();
      var list = (j.data || j.models || []).map(function (x) {
        return typeof x === 'string' ? x : (x.id || x.name || '');
      }).filter(Boolean).sort();
      if (!list.length) throw new Error('列表是空的');
      el.pfModelOptions.innerHTML = list.map(function (m) {
        return '<option value="' + esc(m) + '"></option>';
      }).join('');
      if (list.indexOf(el.pfModel.value.trim()) < 0) el.pfModel.value = list[0];
      toast('拉到 ' + list.length + ' 个模型');
    } catch (err) {
      toast('拉取失败：' + (err.message || err) + '。可以直接手填模型名。', 5000);
    } finally {
      el.btnPfFetch.disabled = false;
      el.btnPfFetch.textContent = '拉取列表';
    }
  }

  /* ---------- 技能 ---------- */

  function enabledSkills() {
    return state.skills.filter(function (s) { return s.enabled && String(s.body || '').trim(); });
  }

  function saveSkills() {
    if (!Store.saveSkills(state.skills)) toast('技能没能存进本机。', 4000);
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
        '<span class="srow-name">' + esc(s.name || '未命名技能') + '</span>' +
        '<span class="srow-hint">' + esc(s.hint || String(s.body || '').slice(0, 40)) + '</span>';
      row.appendChild(main);

      var sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
      sw.setAttribute('aria-label', (s.enabled ? '停用' : '启用') + '技能 ' + (s.name || ''));
      sw.dataset.toggle = s.id;
      sw.innerHTML = '<span class="knob"></span>';
      row.appendChild(sw);

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini-btn';
      edit.dataset.sedit = s.id;
      edit.textContent = '改';
      edit.setAttribute('aria-label', '编辑技能');
      row.appendChild(edit);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn danger';
      del.dataset.sdel = s.id;
      del.textContent = '删';
      del.setAttribute('aria-label', '删除技能');
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
      b.textContent = s.name;
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
    el.skillFormTitle.textContent = s ? '编辑技能' : '新增技能';
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
    if (!name) { toast('给技能起个名字'); el.sfName.focus(); return; }
    if (!body) { toast('指令正文不能是空的'); el.sfBody.focus(); return; }

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
      toast('已添加技能「' + name + '」，已打开');
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
    if (!window.confirm('删除技能「' + (s.name || '未命名') + '」？')) return;
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
    el.effortName.textContent = e.name;
    el.effortPopName.textContent = e.name;
    el.effortRange.value = String(state.prefs.intensity);
    el.btnEffort.dataset.off = e.key === 'off' ? 'true' : 'false';

    var labels = el.effortTicksLabels.children;
    for (var i = 0; i < labels.length; i++) {
      if (i === Number(state.prefs.intensity)) labels[i].classList.add('on');
      else labels[i].classList.remove('on');
    }

    var prov = profileProvider(activeProfile());
    var ok = providerSupportsEffort(prov);
    el.effortNote.textContent = ok ? '' : '这家不认思考强度参数，选了也不会发出去。';
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
    el.ctxRing.title = '上下文 ' + Math.round(pct * 100) + '%（' + chars + ' 字符，' + CTX_LIMIT + ' 封顶）';
    el.ctxRing.setAttribute('aria-label', '上下文占用 ' + Math.round(pct * 100) + '%');
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
    var pref = state.prefs ? state.prefs.theme : 'dark';
    var eff = pref;
    if (pref === 'auto') {
      eff = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = eff;

    var pal = paletteById(state.prefs.palette || 'brass');
    var accent, bg;
    if (pal.id === 'custom') {
      accent = state.prefs.customAccent || '#D8A25C';
      bg = eff === 'light'
        ? blend(state.prefs.customBg || '#0F1613', '#FFFFFF', 0.88)
        : (state.prefs.customBg || '#0F1613');
    } else {
      accent = eff === 'light' ? (pal.accentLight || pal.accent) : pal.accent;
      bg = eff === 'light' ? (pal.bgLight || '#F1F3F0') : pal.bg;
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
    var current = state.prefs.palette || 'brass';
    for (var i = 0; i < PALETTES.length; i++) {
      var p = PALETTES[i];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal';
      b.dataset.pal = p.id;
      if (p.id === current) b.dataset.on = 'true';
      var swatchBg = p.id === 'custom'
        ? (state.prefs.customBg || '#0F1613')
        : p.bg;
      var swatchAccent = p.id === 'custom'
        ? (state.prefs.customAccent || '#D8A25C')
        : p.accent;
      b.innerHTML =
        '<span class="pal-dot" style="background:' + esc(swatchBg) + '">' +
        '<i style="background:' + esc(swatchAccent) + '"></i></span>' +
        '<span class="pal-name">' + esc(p.name) + '</span>';
      box.appendChild(b);
    }
    if (el.paletteCustom) el.paletteCustom.hidden = current !== 'custom';
  }

  function fillPrefsForm() {
    el.fSystem.value = state.prefs.systemPrompt || '';
    el.fTemp.value = String(state.prefs.temperature == null ? 1 : state.prefs.temperature);
    el.tempVal.textContent = Number(el.fTemp.value).toFixed(1);
    el.fMax.value = String(state.prefs.maxTokens || 2048);
    el.fTheme.value = state.prefs.theme || 'dark';
    el.fAccent.value = state.prefs.customAccent || '#D8A25C';
    el.fBg.value = state.prefs.customBg || '#0F1613';
    renderPaletteList();
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
    if (room <= 0) { toast('最多带 ' + MAX_ATTACH_COUNT + ' 个附件'); return; }
    if (list.length > room) {
      list = list.slice(0, room);
      toast('只取前 ' + room + ' 张，一次最多 ' + MAX_ATTACH_COUNT + ' 个附件');
    }
    var jobs = list.map(function (f) {
      return shrinkImage(f).then(function (dataUrl) {
        state.attachments.push({
          id: uid(), kind: 'image', name: f.name || '图片',
          size: Math.round(dataUrl.length * 0.75), dataUrl: dataUrl
        });
      }).catch(function () {
        toast('「' + (f.name || '图片') + '」读不进来', 3000);
      });
    });
    Promise.all(jobs).then(function () {
      renderAttachments();
      var prov = profileProvider(activeProfile());
      if (!prov.vision) {
        toast(prov.name + ' 默认不支持看图，图片可能被忽略。支持看图的有 OpenAI、Gemini、Claude、Grok、通义 VL、硅基流动的部分模型。', 6000);
      }
    });
  }

  function addTextFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var room = MAX_ATTACH_COUNT - state.attachments.length;
    if (room <= 0) { toast('最多带 ' + MAX_ATTACH_COUNT + ' 个附件'); return; }
    if (list.length > room) list = list.slice(0, room);

    var tooBig = list.filter(function (f) { return f.size > MAX_TEXT_BYTES; });
    if (tooBig.length) {
      var names = tooBig.map(function (f) { return f.name; }).join('、');
      if (!window.confirm(names + ' 超过 100 KB。塞进对话会占用很多上下文，确定要加吗？')) {
        list = list.filter(function (f) { return f.size <= MAX_TEXT_BYTES; });
        if (!list.length) return;
      }
    }

    var jobs = list.map(function (f) {
      return readAsText(f).then(function (text) {
        state.attachments.push({
          id: uid(), kind: 'text', name: f.name || '文本',
          size: f.size, text: text
        });
      }).catch(function () {
        toast('「' + (f.name || '文件') + '」读不进来', 3000);
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
      full += (full ? '\n\n' : '') + '【文件：' + docs[j].name + '】\n```' + ext + '\n' + docs[j].text + '\n```';
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
      title: '新对话',
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
      el.btnTemp.textContent = isTemp ? '临时' : '正式';
      el.btnTemp.dataset.on = isTemp ? 'true' : 'false';
      el.btnTemp.title = isTemp
        ? '当前是临时对话，不会保存。点一下改成正式对话'
        : '当前是正式对话，会自动保存。点一下改成临时对话';
      el.btnTemp.setAttribute('aria-label', el.btnTemp.title);
    }

    // 临时且有内容：显示保存
    el.btnSaveTemp.hidden = !(isTemp && !empty);
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
      toast('临时对话：不会存到本机，退出就没了');
    } else {
      persistNow();
      toast('正式对话：会自动保存');
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
    if (!conv.title || conv.title === '新对话') {
      for (var i = 0; i < conv.messages.length; i++) {
        if (conv.messages[i].role === 'user' && conv.messages[i].content) {
          var t = String(conv.messages[i].content).replace(/\s+/g, ' ').trim();
          conv.title = t.length > 24 ? t.slice(0, 24) + '…' : (t || '新对话');
          break;
        }
      }
    }
    persistNow();
    renderTitle();
    renderBarState();
    renderEmpty();
    renderHint();
    toast('已保存到对话列表');
  }

  function openConv(id) {
    if (state.streaming) stopGeneration();
    var conv = Store.loadConv(id);
    if (!conv) { toast('这条对话读不出来了'); return; }
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
      toast('保存失败：本机存储可能已满。先导出备份，再删掉一些旧对话。', 6000);
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
    toast('已删除');
  }

  function renameConv(id) {
    var conv = Store.loadConv(id);
    if (!conv) return;
    var name = window.prompt('改个名字', conv.title);
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

  function maybeRetitle(text) {
    if (!state.conv) return;
    if (state.conv.title && state.conv.title !== '新对话') return;
    var t = text.replace(/\s+/g, ' ').trim();
    state.conv.title = t.length > 24 ? t.slice(0, 24) + '…' : t;
    renderTitle();
  }

  /* ---------- 渲染 ---------- */

  function renderTitle() {
    el.convTitle.textContent = (state.conv && state.conv.title) || '新对话';
  }

  /* 离开临时对话前提醒：临时内容不会进列表 */
  function leaveTempIfNeeded(next) {
    var conv = state.conv;
    if (conv && conv.temp && conv.messages.length) {
      if (!window.confirm('当前是临时对话，离开就丢了。先保存吗？\n\n确定 = 不保存，直接离开')) return;
    }
    next();
  }

  function renderHint() {
    var p = activeProfile();
    var bits = [];
    if (!p) bits.push('未配置密钥');
    else bits.push(p.model || '未选模型');
    bits.push('强度 ' + currentEffort().name);
    var n = enabledSkills().length;
    if (n) bits.push('技能 ' + n);
    if (state.conv && state.conv.temp) bits.push('临时');

    var warn = !p || (profileProvider(p).browserBlocked && !isNative);
    el.statusLine.textContent = bits.join(' · ');
    el.statusLine.dataset.warn = warn ? 'true' : 'false';
    el.modelName.textContent = p ? (p.model || '未选模型') : '未配置密钥';

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
      none.textContent = '还没有对话';
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
      open.innerHTML = '<span class="conv-row-title">' + esc(item.title || '未命名对话') + '</span>' +
        '<span class="conv-row-meta">' + esc(item.model || '') + ' · ' + timeLabel(item.updatedAt) + '</span>';
      row.appendChild(open);

      var mdBtn = document.createElement('button');
      mdBtn.className = 'conv-mini';
      mdBtn.dataset.md = item.id;
      mdBtn.setAttribute('aria-label', '导出为 Markdown');
      mdBtn.textContent = 'MD';
      row.appendChild(mdBtn);

      var del = document.createElement('button');
      del.className = 'conv-mini danger';
      del.dataset.del = item.id;
      del.setAttribute('aria-label', '删除对话');
      del.textContent = '删';
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
        '<p class="empty-lead">先接上你自己的钥匙</p>' +
        '<p class="empty-text">填一个 API Key 就能用。请求从这台设备直接发往服务商，对话只存本机。</p>' +
        '<button class="btn-primary" type="button" data-act="open-keys">填入 API Key</button>';
    } else {
      var prov = profileProvider(p);
      var skillN = enabledSkills().length;
      el.emptyState.innerHTML =
        '<p class="empty-lead">问点什么</p>' +
        '<p class="empty-text">' + esc(p.model || '未指定模型') +
        (skillN ? ' · ' + skillN + ' 个技能' : '') +
        (state.conv && state.conv.temp ? ' · 临时对话' : '') +
        (prov.browserBlocked && !isNative ? '<br>这家服务商不允许浏览器直连。' : '') + '</p>' +
        '<div class="chips">' +
        '<button class="chip" type="button" data-fill="用三句话解释什么是 API Key，假设我完全不懂技术。">解释 API Key</button>' +
        '<button class="chip" type="button" data-fill="帮我看看这段代码有什么问题：">看段代码</button>' +
        '<button class="chip" type="button" data-act="open-skills">加个技能</button>' +
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
    summary.textContent = '思考过程';
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
    if (msg.content) acts.appendChild(mkBtn('复制', function () { copyText(msg.content); }));
    if (msg.reasoning) acts.appendChild(mkBtn('复制思考', function () { copyText(msg.reasoning); }));
    if (msg.role === 'assistant' && state.conv && idx === state.conv.messages.length - 1 && !state.streaming) {
      acts.appendChild(mkBtn('重新生成', regenerate));
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
    who.textContent = msg.role === 'user' ? '你' : (msg.model || 'AI');
    head.appendChild(who);
    if (msg.at) {
      var when = document.createElement('span');
      when.textContent = timeLabel(msg.at);
      head.appendChild(when);
    }
    if (msg.skills && msg.skills.length) {
      var sk = document.createElement('span');
      sk.className = 'msg-skills';
      sk.textContent = '技能 ' + msg.skills.length;
      sk.title = msg.skills.join('、');
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
      var hint = {
        400: '请求被拒绝：检查模型名是否存在、参数是否超出范围。',
        401: '密钥无效或已失效，去设置里换一条或重新填。',
        402: '账户余额不足，去服务商控制台充值。',
        403: '没有权限：这个 Key 可能没有开通该模型。',
        404: '接口地址不对：检查地址里是否少了 /v1 这类版本段。',
        413: '内容太长，超出了模型的上下文窗口。',
        422: '参数不合法，检查模型名和最大回复长度。',
        429: '请求太频繁或额度用尽，等一会儿再试。',
        500: '服务商内部出错，稍后重试。',
        502: '服务商网关出错，稍后重试。',
        503: '服务暂时不可用，稍后重试。'
      }[err.status];
      var text = hint || ('请求失败（HTTP ' + err.status + '）。');
      if (/\bmodel\b/i.test(err.message || '') && !hint) text = '模型名好像不对：' + err.message;
      return text + (err.message ? '\n\n服务商原话：' + err.message : '');
    }

    if (err && err.name === 'AbortError') return '（已停止）';
    if (!navigator.onLine) return '设备当前没有联网。';

    if (err && (err.name === 'TypeError' || err.name === 'NetworkError' || /fetch/i.test(err.message || ''))) {
      if (prov.browserBlocked && !isNative) {
        return '连不上 ' + prov.name + '：这家服务商不允许浏览器直连（缺少 CORS 允许头）。' +
          '换成支持直连的服务商，或者打包成 App 用原生请求绕开这个限制。';
      }
      return '连不上 ' + prov.name + '。可能是网络不通、需要代理，或者接口地址填错了。' +
        '（当前地址：' + ((prof && prof.baseUrl) || '未填') + '）';
    }

    return '出错了：' + ((err && err.message) || String(err));
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
    if (!prof) throw new Error('还没有密钥。先去设置里加一条。');
    var prov = profileProvider(prof);
    var base = String(prof.baseUrl || prov.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('接口地址是空的，去设置里填一个。');
    if (!prof.apiKey) throw new Error('这条密钥没有填 API Key。');
    if (!prof.model) throw new Error('这条密钥没有指定模型。');

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
    btn.setAttribute('aria-label', busy ? '停止生成' : '发送');
    btn.innerHTML = busy
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  }

  function stopGeneration() {
    if (state.controller) state.controller.abort();
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

    try {
      var req = buildRequest(history);
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
      if (!res.body) throw new Error('这个浏览器不支持流式读取。');

      var protocol = profileProvider(activeProfile()).protocol;
      await readStream(res.body, protocol, {
        onText: function (t) { botMsg.content += t; paint(); },
        onThink: function (t) {
          botMsg.reasoning = (botMsg.reasoning || '') + t;
          if (!botMsg.content) paint();
          else ensureReasoning(node, botMsg);
        }
      });

      if (!botMsg.content && !botMsg.reasoning) {
        botMsg.content = '（服务商没有返回内容，可能是模型名不对或账户额度已用尽。）';
        node.dataset.error = 'true';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (!botMsg.content) botMsg.content = '（已停止）';
        else botMsg.content += '\n\n（已停止）';
      } else {
        botMsg.content = errorText(err);
        node.dataset.error = 'true';
      }
    } finally {
      delete node.dataset.streaming;
      bodyEl.innerHTML = mdToHtml(botMsg.content || '');
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
    if (!prof) { openSettings(); openProfileForm(''); toast('先加一条密钥'); return; }
    if (!prof.apiKey) { openSettings(); toast('这条密钥没填 Key'); return; }
    if (!prof.model) { openSettings(); toast('这条密钥没指定模型'); return; }
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
      effort: currentEffort().name
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
      effort: currentEffort().name
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

  function fillSettingsForm() {
    renderProfileList();
    if (!el.profileForm.hidden) {
      // 保持正在编辑的内容不动
    } else if (!state.profiles.length) {
      openProfileForm('');
    }
    fillPrefsForm();
  }

  function openSettings() {
    closeDrawer();
    fillSettingsForm();
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
    if (!payload.conversations.length) { toast('还没有可导出的对话'); return; }
    download('钥匙备份-' + stamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('已导出 ' + payload.conversations.length + ' 条对话（不含密钥）');
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var payload = JSON.parse(String(reader.result));
        var n = Store.importAll(payload);
        state.index = Store.loadIndex();
        renderConvList();
        toast(n ? ('导入了 ' + n + ' 条对话') : '没有新对话可导入');
      } catch (e) {
        toast('文件读不出来，确认是备份 JSON', 4000);
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
    toast('已导出 Markdown');
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
      toast('这个浏览器不支持语音输入。Chrome 能用，Safari 和 Firefox 不行。', 4000);
      return;
    }
    if (recog) {
      recog.stop();
      return;
    }
    try {
      recog = new SR();
    } catch (e) {
      toast('麦克风没启动起来。', 3000);
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
      toast('语音识别中断了，检查是不是拦了麦克风权限。', 4000);
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
      toast('在听了，说完再点一次麦克风', 2400);
    } catch (e) {
      toast('麦克风没启动起来。', 3000);
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
    el.btnKeyIcon.addEventListener('click', function () { closePops(); openSettings(); });
    el.btnModel.addEventListener('click', function () { closePops(); openSettings(); });
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
      if (t.dataset.act === 'open-keys') { openSettings(); return; }
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
        toast('已切换');
      }
    });

    el.btnAddProfile.addEventListener('click', function () { openProfileForm(''); });
    el.btnPfCancel.addEventListener('click', closeProfileForm);
    el.btnPfSave.addEventListener('click', saveProfileForm);
    el.pfProvider.addEventListener('change', function () { onProfileProviderChange(false); });
    el.btnPfToggleKey.addEventListener('click', function () {
      var showing = el.pfKey.type === 'text';
      el.pfKey.type = showing ? 'password' : 'text';
      el.btnPfToggleKey.textContent = showing ? '显示' : '隐藏';
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
      el.sfName.value = s.name;
      el.sfHint.value = s.hint;
      el.sfBody.value = s.body;
      el.sfName.focus();
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
        el.fAccent.value = state.prefs.customAccent || '#D8A25C';
        el.fBg.value = state.prefs.customBg || '#0F1613';
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

    el.btnSaveSettings.addEventListener('click', function () {
      readPrefsForm();
      closeSettings();
      renderHint();
      renderEmpty();
      toast('已保存');
    });
    el.btnCloseSettings.addEventListener('click', closeSettings);
    el.btnCloseSkills.addEventListener('click', closeSkills);

    el.btnClearKeys.addEventListener('click', function () {
      if (!state.profiles.length) { toast('本来就没有密钥'); return; }
      if (!window.confirm('删掉全部 ' + state.profiles.length + ' 条密钥？这会一并清空正在用的这条。')) return;
      state.profiles = [];
      state.activeId = '';
      saveProfiles();
      Store.saveActiveProfile('');
      closeProfileForm();
      renderProfileList();
      renderHint();
      renderEmpty();
      openProfileForm('');
      toast('密钥已清空');
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
    el.btnKeyIcon = $('btnKeyIcon');
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
    el.btnSaveSettings = $('btnSaveSettings');
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
    loadPrefs();    applyTheme();
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

    if (!Store.isPersistent()) {
      toast('这个浏览器不允许网页保存数据，密钥和对话只存在内存里。请用 http 地址打开，或把页面部署到静态托管。', 9000);
    } else if (!state.profiles.length) {
      setTimeout(function () { openSettings(); }, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
