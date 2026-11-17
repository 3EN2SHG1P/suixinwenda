/**
 * 文件：desktop/src/renderer/lib/markdown.js
 * 职责：Markdown → HTML（先转义再拼标签，XSS 防线就在这几个函数里）+ 长代码块的展开状态。
 *
 * 为什么单独成文件：app.js 顶层无条件 `bootstrap()`、首行就碰 DOM，在 Node 里 require 必然
 * `window is not defined`，导致这条安全链路只能靠冒烟里一条 `xss-not-injected` 断言兜着。
 * 拆成纯函数模块后可以用 `node --test` 直接压负面用例（不再依赖 Electron 与 GUI）。
 *
 * 双出口：页面里按 classic script 加载（挂 window.SXWMarkdown），单测里 require（挂 module.exports）。
 */
// 代码块超过该行数默认折叠（点「展开」看全）
const CODE_FOLD_LINES = 16;

// 已展开的长代码块（按内容 key 记）：流式每帧重渲染时保持用户手动展开的状态
const expandedCode = new Set();

function codeKey(lang, code) {
  const sample = `${lang}|${code.length}|${code.slice(0, 120)}`;
  let hash = 0;
  for (let index = 0; index < sample.length; index += 1) {
    hash = (hash * 31 + sample.charCodeAt(index)) | 0;
  }
  return `c${hash}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 轻量代码高亮：只认注释 / 字符串 / 数字 / 关键字四类，够撑起效果图的三色，
// 不做完整语法分析（做错了不如不做）。所有片段先 escape 再包 span。
const CODE_KEYWORDS = new Set(
  (
    'select from where and or not null insert into values update set delete join left right inner outer on as ' +
    'group by order having limit offset create table index primary key default alter drop distinct count sum avg ' +
    'function return if else for while class const let var new try catch finally throw switch case break continue ' +
    'import export default async await yield this super extends static public private def elif in is lambda with ' +
    'print true false none nil undefined void int str bool float double char'
  ).split(' ')
);

function highlightCode(code) {
  const source = String(code);
  const pattern =
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  let match = pattern.exec(source);
  while (match) {
    out += escapeHtml(source.slice(last, match.index));
    if (match[1]) {
      out += `<span class="tok-c">${escapeHtml(match[1])}</span>`;
    } else if (match[2]) {
      out += `<span class="tok-s">${escapeHtml(match[2])}</span>`;
    } else if (match[3]) {
      out += `<span class="tok-n">${escapeHtml(match[3])}</span>`;
    } else if (match[4] && CODE_KEYWORDS.has(match[4].toLowerCase())) {
      out += `<span class="tok-k">${escapeHtml(match[4])}</span>`;
    } else {
      out += escapeHtml(match[0]);
    }
    last = pattern.lastIndex;
    match = pattern.exec(source);
  }
  out += escapeHtml(source.slice(last));
  return out;
}

// 行内非代码部分的替换链：图片 / 链接 / 粗体 / 斜体 / 删除线
function renderInlineRest(text) {
  let result = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt) => `<span class="md-image">${alt || '图片'}</span>`);
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  result = result.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return result;
}

// 行内元素：`代码` / **粗体** / *斜体* / [文本](http链接) / ![图片](地址)
// 早期实现是把行内代码抠出来、用 `\u0000序号\u0000` 占位、最后回填。问题有两处：
//   1. 正文里真出现同样的字面量就会被当成占位符，渲染成 `<code>undefined</code>`；
//   2. 占位符阶段一旦漏回填，NUL 控制字符会原样留在页面上。
// 现在改成按反引号切段：代码段直接出 `<code>`，其余段各自跑替换链，两条路径互不干扰。
function renderInline(escapedText) {
  const segments = String(escapedText).split(/(`[^`]+`)/);
  let out = '';
  for (const segment of segments) {
    if (segment.length >= 2 && segment.startsWith('`') && segment.endsWith('`')) {
      out += `<code>${segment.slice(1, -1)}</code>`;
      continue;
    }
    out += renderInlineRest(segment);
  }
  return out;
}

// 块级元素：标题 / 引用 / 无序与有序列表 / 分隔线 / 代码块 / 段落（软换行转 <br />）
function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = '';
  let index = 0;

  const closeList = () => {
    if (listType) {
      out.push(listType === 'ul' ? '</ul>' : '</ol>');
      listType = '';
    }
  };

  while (index < lines.length) {
    const line = lines[index];

    // 代码块：``` 起始到下一行 ``` 结束，内容只转义不解析
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      closeList();
      const lang = fence[1].trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      // 长代码默认折叠（>16 行）；展开状态按内容 key 记住，流式重渲染不会把用户展开的代码折回
      const codeText = codeLines.join('\n');
      const key = codeKey(lang, codeText);
      const foldable = codeLines.length > CODE_FOLD_LINES;
      const collapsed = foldable && !expandedCode.has(key);
      const gutter = codeLines.map((item, lineNo) => lineNo + 1).join('\n');
      out.push(
        `<div class="code-block${collapsed ? ' is-collapsed' : ''}" data-lines="${codeLines.length}" data-code-key="${key}">` +
          '<div class="code-head">' +
          `<span class="code-lang">${escapeHtml(lang || 'text')}</span>` +
          '<span class="code-tools">' +
          (foldable
            ? `<button class="code-toggle" type="button">${collapsed ? `展开 ${codeLines.length} 行` : '收起'}</button>`
            : '') +
          '<button class="code-copy" type="button">复制</button></span></div>' +
          `<div class="code-block-body"><pre><span class="code-gutter" aria-hidden="true">${gutter}</span><code>${highlightCode(
            codeText
          )}</code></pre></div></div>`
      );
      continue;
    }

    if (!line.trim()) {
      closeList();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      out.push('<hr />');
      index += 1;
      continue;
    }

    // 表格：| a | b | 且下一行是 |---|---| 分隔行；AI 回答里表格出现频率很高
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      index + 1 < lines.length &&
      /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/.test(lines[index + 1])
    ) {
      closeList();
      const parseRow = (row) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => renderInline(escapeHtml(cell.trim())));
      const headCells = parseRow(line);
      index += 2;
      const bodyRows = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        bodyRows.push(parseRow(lines[index]));
        index += 1;
      }
      out.push(
        '<div class="table-wrap"><table><thead><tr>' +
          headCells.map((cell) => `<th>${cell}</th>`).join('') +
          '</tr></thead><tbody>' +
          bodyRows
            .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table></div>'
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>${quoteLines.map((item) => renderInline(escapeHtml(item))).join('<br />')}</blockquote>`);
      continue;
    }

    // 任务列表：- [ ] / - [x]，AI 常用它列待办
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul class="task-list">');
        listType = 'ul';
      }
      const done = task[1].toLowerCase() === 'x';
      out.push(
        `<li class="task-item${done ? ' is-done' : ''}"><span class="task-box" aria-hidden="true">${
          done ? '✓' : ''
        }</span><span>${renderInline(escapeHtml(task[2]))}</span></li>`
      );
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(escapeHtml(bullet[1]))}</li>`);
      index += 1;
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(escapeHtml(ordered[1]))}</li>`);
      index += 1;
      continue;
    }

    closeList();
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+\.\s|-{3,}|\|)/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    out.push(`<p>${paragraph.map((item) => renderInline(escapeHtml(item))).join('<br />')}</p>`);
  }

  closeList();
  return out.join('');
}

// 顶层 const 在 classic script 里共享同一个全局词法作用域，两个 lib 都叫 api 会直接 SyntaxError
const markdownApi = { escapeHtml, renderInline, renderMarkdown, codeKey, expandedCode };
if (typeof window !== 'undefined') {
  window.SXWMarkdown = markdownApi;
}
if (typeof module !== 'undefined') {
  module.exports = markdownApi;
}
