/**
 * 文件：desktop/test/session-page.test.js
 * 职责：会话列表分页合并的边界——重复 id 丢弃、满页才认为有更早、顺序保持。
 * 跑法：`cd desktop; npm test`
 */
const test = require('node:test');
const assert = require('node:assert');

const { mergeConversationPage } = require('../src/renderer/lib/session-page.js');

const page = (from, count) =>
  Array.from({ length: count }, (_, index) => ({ id: from + index, title: `会话${from + index}` }));

test('首屏满一页时认为还有更早', () => {
  const merged = mergeConversationPage([], page(1, 100), 100);
  assert.strictEqual(merged.items.length, 100);
  assert.strictEqual(merged.added.length, 100);
  assert.strictEqual(merged.hasMore, true);
});

test('不满一页时认为到底', () => {
  const merged = mergeConversationPage(page(1, 100), page(101, 20), 100);
  assert.strictEqual(merged.items.length, 120);
  assert.strictEqual(merged.hasMore, false);
});

test('满页但含重复 id 时只追加新的，并保持已加载顺序', () => {
  // offset 错位：第二页把已加载的 96~100 又带回来了
  const loaded = page(1, 100);
  const merged = mergeConversationPage(loaded, page(96, 100), 100);
  assert.strictEqual(merged.added.length, 95);
  assert.strictEqual(merged.items.length, 195);
  assert.deepStrictEqual(
    merged.items.slice(0, 3).map((item) => item.id),
    [1, 2, 3]
  );
  assert.strictEqual(merged.hasMore, true);
});

test('整页都是重复时不重复追加且视为到底', () => {
  const loaded = page(1, 100);
  const merged = mergeConversationPage(loaded, page(1, 100), 100);
  assert.strictEqual(merged.added.length, 0);
  assert.strictEqual(merged.items.length, 100);
  assert.strictEqual(merged.hasMore, false);
});

test('同一页内自带重复 id 也只保留一条', () => {
  const rows = [
    { id: 7, title: 'a' },
    { id: 8, title: 'b' },
    { id: 7, title: 'a' }
  ];
  const merged = mergeConversationPage([], rows, 3);
  assert.deepStrictEqual(
    merged.items.map((item) => item.id),
    [7, 8]
  );
  assert.strictEqual(merged.hasMore, true);
});
