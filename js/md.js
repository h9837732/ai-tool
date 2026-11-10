/* 极简 Markdown 渲染：不依赖任何外部库，离线可用。
   支持：代码块、行内代码、粗体、斜体、链接、标题、有序/无序列表、引用、分隔线。
   安全策略：先整体转义 HTML，再把受控的标签拼回去，不会执行模型返回的 HTML。 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function mdToHtml(src) {
  const codeBlocks = [];
  let s = String(src == null ? '' : src).replace(/\r\n/g, '\n');

  // 1. 先把围栏代码块抽出来，避免内部内容被后续规则改写
  s = s.replace(/```([^\n`]*)\n([\s\S]*?)```/g, function (_m, lang, code) {
    const i = codeBlocks.push({ lang: String(lang).trim(), code: code }) - 1;
    return '\u0000C' + i + '\u0000';
  });
  // 未闭合的代码块（流式输出中途）：整段当代码显示
  s = s.replace(/```([^\n`]*)\n([\s\S]*)$/, function (_m, lang, code) {
    const i = codeBlocks.push({ lang: String(lang).trim(), code: code }) - 1;
    return '\u0000C' + i + '\u0000';
  });

  s = escapeHtml(s);

  // 2. 行内元素
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 3. 块级元素
  const lines = s.split('\n');
  const out = [];
  let para = [];
  let listType = null;

  function flushPara() {
    if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
  }
  function closeList() {
    if (listType) { out.push('</' + listType + '>'); listType = null; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[ \t]+$/, '');
    const m0 = line.match(/^\u0000C(\d+)\u0000$/);
    if (m0) { flushPara(); closeList(); out.push(line); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const lv = Math.min(m[1].length + 1, 6);
      out.push('<h' + lv + '>' + m[2] + '</h' + lv + '>');
      continue;
    }
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushPara(); closeList(); out.push('<hr>'); continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara(); closeList(); out.push('<blockquote>' + m[1] + '</blockquote>'); continue;
    }
    if ((m = line.match(/^[-*+]\s+(.*)$/))) {
      flushPara();
      if (listType && listType !== 'ul') closeList();
      if (!listType) { out.push('<ul>'); listType = 'ul'; }
      out.push('<li>' + m[1] + '</li>');
      continue;
    }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (listType && listType !== 'ol') closeList();
      if (!listType) { out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + m[1] + '</li>');
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();

  // 4. 还原代码块
  return out.join('').replace(/\u0000C(\d+)\u0000/g, function (_m, idx) {
    const b = codeBlocks[Number(idx)] || { lang: '', code: '' };
    const attr = b.lang ? ' data-lang="' + escapeHtml(b.lang) + '"' : '';
    return '<pre' + attr + '><code>' + escapeHtml(b.code.replace(/\n$/, '')) + '</code></pre>';
  });
}
