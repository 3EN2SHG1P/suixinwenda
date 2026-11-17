const test = require('node:test');
const assert = require('node:assert');
const { splitMarkdownBlocks } = require('../src/renderer/lib/stream-blocks.js');

// 所有用例的第一断言都是「无损」：切错一个字符就会在回答里丢内容
function assertLossless(text) {
  const { closed, tail } = splitMarkdownBlocks(text);
  assert.strictEqual(closed.join('') + tail, text);
  return { closed, tail };
}

test('空文本与单段文本全部进 tail', () => {
  assert.deepStrictEqual(splitMarkdownBlocks(''), { closed: [], tail: '' });
  const single = assertLossless('只有一段话，没有空行');
  assert.deepStrictEqual(single.closed, []);
  assert.strictEqual(single.tail, '只有一段话，没有空行');
});

test('多段落：已闭合的段落进 closed，末段留在 tail', () => {
  const text = '第一段。\n\n第二段。\n\n第三段还在增长';
  const { closed, tail } = assertLossless(text);
  assert.deepStrictEqual(closed, ['第一段。\n\n', '第二段。\n\n']);
  assert.strictEqual(tail, '第三段还在增长');
});

test('未闭合的围栏代码块不会进 closed', () => {
  const text = '说明：\n\n```js\nconst a = 1;\n\nconst b = 2;';
  const { closed, tail } = assertLossless(text);
  assert.deepStrictEqual(closed, ['说明：\n\n']);
  assert.ok(tail.includes('```js'), '未闭合代码块必须整体留在 tail');
});

test('已闭合的围栏代码块可以进 closed', () => {
  const text = '说明：\n\n```js\nconst a = 1;\n```\n\n后面还在写';
  const { closed, tail } = assertLossless(text);
  assert.strictEqual(closed.length, 2);
  assert.ok(closed[1].includes('const a = 1;'));
  assert.strictEqual(tail, '后面还在写');
});

test('代码块内的空行不当作块边界', () => {
  const text = '```\ncode\n\nmore\n```\n\n尾巴';
  const { closed } = assertLossless(text);
  assert.strictEqual(closed.length, 1, '代码块整体算一个块');
  assert.ok(closed[0].includes('more'));
});

test('相邻的同类容器（列表/引用/表格）合并进 tail，避免断开成两个容器', () => {
  const listText = '- 甲\n\n- 乙\n\n- 丙';
  const list = assertLossless(listText);
  assert.deepStrictEqual(list.closed, [], '相邻列表项不能各自独立渲染');
  assert.strictEqual(list.tail, listText);

  const quoteText = '> 甲\n\n> 乙\n\n尾巴';
  const quote = assertLossless(quoteText);
  assert.deepStrictEqual(quote.closed, [], '相邻引用块同样合并');
  assert.strictEqual(quote.tail, quoteText);

  const tableText = '|a|b|\n\n|c|d|\n\n尾巴';
  const table = assertLossless(tableText);
  assert.deepStrictEqual(table.closed, []);
  assert.strictEqual(table.tail, tableText);
});

test('列表后面接普通段落时可以切出去', () => {
  const text = '- 甲\n- 乙\n\n普通段落。\n\n尾巴';
  const { closed } = assertLossless(text);
  assert.strictEqual(closed.length, 2, '列表块与其后的段落不同类，可以进 closed');
});

test('文本变短（重新生成 / 停止回填）时切分结果自洽', () => {
  const long = '甲段。\n\n乙段。\n\n丙段。\n\n丁段。';
  const short = '甲段。\n\n乙段。';
  const a = assertLossless(long);
  const b = assertLossless(short);
  assert.ok(a.closed.length >= b.closed.length, '长文本前缀块数不少于短文本');
  assert.strictEqual(b.tail, '乙段。');
});
