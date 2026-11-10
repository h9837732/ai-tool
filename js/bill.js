/* 账单相关：计费时段 / 余额 / 本机用量 / 教程。
   挂在 window.Bill 上，由 app.js 调用。 */
(function (global) {
  'use strict';

  /* ---------- 计费时段 ---------- */

  /* DeepSeek 官方规则（2026-11）：
     北京时间 周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰，
     其余时段（含周末、法定节假日全天）为空闲，空闲价 = 高峰价的一半。

     这里只按「星期 + 时刻」判断，不识别法定节假日——
     节假日期间会误报为高峰，界面上要说明这一点。 */
  function beijingParts(now) {
    var d = new Date((now || Date.now()) + 8 * 3600 * 1000);
    return {
      day: d.getUTCDay(),                       // 0 = 周日
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      hhmm: ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2)
    };
  }

  var PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

  function deepseekPeriod(now) {
    var t = beijingParts(now);
    var weekday = t.day >= 1 && t.day <= 5;
    var inWindow = PEAK_WINDOWS.some(function (w) {
      return t.minutes >= w[0] && t.minutes < w[1];
    });
    var peak = weekday && inWindow;

    /* 下一次切换的时间（分钟数） */
    var nextAt = null;
    if (peak) {
      for (var i = 0; i < PEAK_WINDOWS.length; i++) {
        if (t.minutes < PEAK_WINDOWS[i][1]) { nextAt = PEAK_WINDOWS[i][1]; break; }
      }
    } else {
      if (weekday) {
        for (var j = 0; j < PEAK_WINDOWS.length; j++) {
          if (t.minutes < PEAK_WINDOWS[j][0]) { nextAt = PEAK_WINDOWS[j][0]; break; }
        }
      }
    }

    var remain = nextAt === null ? null : nextAt - t.minutes;
    return {
      peak: peak,
      weekday: weekday,
      hhmm: t.hhmm,
      remainMinutes: remain
    };
  }

  /* ---------- 余额解析 ---------- */

  /* 把各家五花八门的返回统一成 { rows: [{label, value}], available } */
  function parseBalance(kind, j) {
    var rows = [];
    var available = null;

    function num(v) {
      var n = Number(v);
      return isNaN(n) ? null : n;
    }

    if (!j) return { rows: rows, available: available, raw: '' };

    if (kind === 'deepseek') {
      /* { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] } */
      var infos = j.balance_infos || [];
      for (var i = 0; i < infos.length; i++) {
        var b = infos[i];
        var cur = b.currency === 'USD' ? '$' : '¥';
        rows.push({ label: '总余额', value: cur + b.total_balance });
        rows.push({ label: '充值余额', value: cur + b.topped_up_balance });
        rows.push({ label: '赠送余额', value: cur + b.granted_balance });
        if (available === null) available = num(b.total_balance);
      }
      if (j.is_available === false) available = 0;
      return { rows: rows, available: available, raw: '' };
    }

    if (kind === 'kimi') {
      /* { code, data: { available_balance, voucher_balance, cash_balance } } */
      var d = j.data || {};
      rows.push({ label: '可用余额', value: '¥' + (d.available_balance != null ? d.available_balance : '-') });
      rows.push({ label: '现金余额', value: '¥' + (d.cash_balance != null ? d.cash_balance : '-') });
      rows.push({ label: '代金券', value: '¥' + (d.voucher_balance != null ? d.voucher_balance : '-') });
      return { rows: rows, available: num(d.available_balance), raw: '' };
    }

    if (kind === 'siliconflow') {
      /* { data: { balance, chargeBalance, totalBalance, ... } } */
      var sd = j.data || j;
      var pick = function () {
        for (var k = 0; k < arguments.length; k++) {
          if (sd[arguments[k]] != null) return sd[arguments[k]];
        }
        return null;
      };
      var total = pick('totalBalance', 'total_balance', 'balance');
      var charge = pick('chargeBalance', 'charge_balance');
      if (total != null) rows.push({ label: '总余额', value: '¥' + total });
      if (charge != null) rows.push({ label: '充值余额', value: '¥' + charge });
      return { rows: rows, available: num(total), raw: '' };
    }

    if (kind === 'openrouter') {
      /* { data: { total_credits, total_usage } } */
      var od = j.data || j;
      var credits = num(od.total_credits);
      var used = num(od.total_usage);
      if (credits != null) rows.push({ label: '累计充值', value: '$' + credits.toFixed(2) });
      if (used != null) rows.push({ label: '累计使用', value: '$' + used.toFixed(2) });
      if (credits != null && used != null) {
        rows.push({ label: '剩余', value: '$' + (credits - used).toFixed(2) });
        available = credits - used;
      }
      return { rows: rows, available: available, raw: '' };
    }

    /* 未知结构：把一层标量兜底列出来，总比空白好 */
    var flat = j.data && typeof j.data === 'object' ? j.data : j;
    for (var key in flat) {
      if (!Object.prototype.hasOwnProperty.call(flat, key)) continue;
      var v = flat[key];
      if (typeof v === 'number' || typeof v === 'string') {
        rows.push({ label: key, value: String(v) });
        if (available === null && /balance/i.test(key)) available = num(v);
      }
    }
    return { rows: rows.slice(0, 8), available: available, raw: '' };
  }

  /* ---------- 本机用量 ---------- */

  var K_USAGE = 'keyapp:usage:';

  function loadUsage(profileId) {
    try {
      var raw = localStorage.getItem(K_USAGE + profileId);
      var v = raw ? JSON.parse(raw) : null;
      if (v && typeof v === 'object') return v;
    } catch (e) { /* 忽略 */ }
    return { requests: 0, prompt: 0, completion: 0, total: 0, since: Date.now() };
  }

  function saveUsage(profileId, u) {
    try { localStorage.setItem(K_USAGE + profileId, JSON.stringify(u)); return true; }
    catch (e) { return false; }
  }

  function addUsage(profileId, usage) {
    if (!profileId || !usage) return null;
    var pt = Number(usage.prompt_tokens);
    var ct = Number(usage.completion_tokens);
    var tt = Number(usage.total_tokens);
    if (isNaN(pt) && isNaN(ct) && isNaN(tt)) return null;

    var u = loadUsage(profileId);
    u.requests = (u.requests || 0) + 1;
    u.prompt = (u.prompt || 0) + (isNaN(pt) ? 0 : pt);
    u.completion = (u.completion || 0) + (isNaN(ct) ? 0 : ct);
    u.total = (u.total || 0) + (isNaN(tt) ? ((isNaN(pt) ? 0 : pt) + (isNaN(ct) ? 0 : ct)) : tt);
    u.lastAt = Date.now();
    saveUsage(profileId, u);
    return u;
  }

  function resetUsage(profileId) {
    saveUsage(profileId, { requests: 0, prompt: 0, completion: 0, total: 0, since: Date.now() });
  }

  global.Bill = {
    deepseekPeriod: deepseekPeriod,
    parseBalance: parseBalance,
    loadUsage: loadUsage,
    addUsage: addUsage,
    resetUsage: resetUsage
  };
})(window);
