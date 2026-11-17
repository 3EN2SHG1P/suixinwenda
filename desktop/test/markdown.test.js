/**
 * 文件：desktop/test/markdown.test.js
 * 职责：Markdown 渲染器的负面用例（XSS 防线）与长代码块展开状态。
 * 跑法：`cd desktop; npm test`（Node 22/24 均可，node --test 显式列文件）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { escapeHtml, renderInline, renderMarkdown, codeKey, expandedCode } = require(
  '../src/renderer/lib/markdown.js'
);

test('escapeHtml 转义全部五个危险字符', () => {
  assert.strictEqual(
    escapeHtml(`<&>"'`),
    '&lt;&amp;&gt;&quot;&#39;'
  );
});

test('javascript: 链接不被渲染成 <a>', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.ok(!/<a\s/i.test(html), `不许出现 <a>：${html}`);
  assert.ok(!/href\s*=\s*"javascript:/i.test(html), `不许出现 javascript: 协议：${html}`);
});

test('data: 链接不被渲染成 <a>', () => {
  const html = renderMarkdown('[点我](data:text/html;base64,PHNjcmlwdD4=)');
  assert.ok(!/<a\s/i.test(html), `不许出现 <a>：${html}`);
});

test('http 链接正常渲染且带 noopener', () => {
  const html = renderMarkdown('[示例](https://example.com/a?b=1)');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">示例<\/a>/);
});

test('正文里的旧占位符字面量原样显示，不被当成占位符', () => {
  // 老实现用 \u0000序号\u0000 当行内代码占位符：正文里真出现这种字面量会渲染出 <code>undefined</code>
  const html = renderInline('\u00000\u0000 与 `跑` 混排');
  assert.ok(!html.includes('undefined'), `不许渲染出 undefined：${html}`);
  assert.ok(html.includes('\u00000\u0000'), '原字面量应按原样保留');
  assert.ok(html.includes('<code>跑</code>'), '正常行内代码仍要渲染');
  assert.ok(!html.includes('\u0000<code>'), '代码占位不该再产生 NUL 残片');
});

test('行内代码里的星号与链接不被二次解析', () => {
  const html = renderInline('`**not bold**` 与 `[x](https://a.b)`');
  assert.ok(html.includes('<code>**not bold**</code>'), `代码段应原样保留：${html}`);
  assert.ok(!/<strong>/.test(html), `代码段里的 ** 不该变粗体：${html}`);
  assert.ok(!/<a\s/.test(html), `代码段里的链接语法不该变 <a>：${html}`);
});

test('<img onerror> 只作为文本出现，不产生标签', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/i.test(html), `不许出现 <img>：${html}`);
  assert.ok(html.includes('&lt;img'), `应被转义成文本：${html}`);
});

test('<svg onload> 只作为文本出现，不产生标签', () => {
  const html = renderMarkdown('<svg onload=alert(1)></svg>');
  assert.ok(!/<svg/i.test(html), `不许出现 <svg>：${html}`);
  assert.ok(html.includes('&lt;svg'), `应被转义成文本：${html}`);
});

test('代码块里的 <script> 只转义不执行', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
  assert.ok(!/<script/i.test(html), `代码块里不许出现 <script>：${html}`);
  assert.ok(html.includes('&lt;script&gt;'), `应被转义：${html}`);
});

test('链接标签里的属性逃逸被转义', () => {
  const html = renderMarkdown('[a" onmouseover="alert(1)](https://example.com/x)');
  assert.ok(!/onmouseover="alert/.test(html), `属性逃逸成功：${html}`);
  assert.ok(html.includes('&quot;'), `引号应被转义：${html}`);
});

test('</textarea> 截断不会逃出标签', () => {
  const html = renderMarkdown('</textarea><script>alert(1)</script>');
  assert.ok(!/<\/textarea>\s*<script/i.test(html), `不许原样输出：${html}`);
  assert.ok(html.includes('&lt;/textarea&gt;'), `应被转义：${html}`);
});

test('renderInline 的代码占位符不会被二次解析', () => {
  const html = renderInline(escapeHtml('`<b>x</b>` 与 **粗体**'));
  assert.strictEqual(html, '<code>&lt;b&gt;x&lt;/b&gt;</code> 与 <strong>粗体</strong>');
});

test('超长代码块默认折叠，加入 expandedCode 后展开', () => {
  const code = Array.from({ length: 20 }, (item, index) => `line${index}`).join('\n');
  const markdown = '```js\n' + code + '\n```';
  const key = codeKey('js', code);

  const collapsed = renderMarkdown(markdown);
  assert.ok(collapsed.includes('is-collapsed'), '超 16 行应默认折叠');
  assert.ok(collapsed.includes('data-code-key="' + key + '"'), '应带内容 key');
  assert.ok(collapsed.includes('展开 20 行'), '按钮文案应为展开');

  expandedCode.add(key);
  try {
    const expanded = renderMarkdown(markdown);
    assert.ok(!expanded.includes('is-collapsed'), '记住展开后不得再折叠');
    assert.ok(expanded.includes('>收起</button>'), '按钮文案应变为收起');
  } finally {
    expandedCode.delete(key);
  }
});

test('短代码块不折叠也不出折叠按钮', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.ok(!html.includes('is-collapsed'));
  assert.ok(!html.includes('code-toggle'));
});

test('表格 / 引用 / 任务列表仍按原样渲染', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(html.includes('<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>'));

  assert.strictEqual(renderMarkdown('> 引用一行'), '<blockquote>引用一行</blockquote>');

  const task = renderMarkdown('- [x] 已做');
  assert.ok(task.includes('class="task-item is-done"'));
});

test('expandedCode 是模块级同一份 Set 引用', () => {
  const again = require('../src/renderer/lib/markdown.js');
  assert.strictEqual(again.expandedCode, expandedCode, '两次 require 必须是同一个 Set，否则展开状态会丢');
});
