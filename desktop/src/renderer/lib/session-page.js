/**
 * 文件：desktop/src/renderer/lib/session-page.js
 * 职责：会话列表分页的纯逻辑——按 id 去重合并下一页、判断后端是否还有更早的会话。
 *
 * 为什么单独成文件：这段的难点（offset 错位导致的重复必须丢弃、满页才算有更多）
 * 冒烟测不到——假后端只有 2 条会话，永远不满一页；抽成纯函数才能用 `node --test` 压边界。
 *
 * 双出口：页面里按 classic script 加载（挂 window.SXWSessionPage），单测里 require。
 */
function mergeConversationPage(loaded, rows, pageSize) {
  const items = Array.isArray(loaded) ? loaded : [];
  const page = Array.isArray(rows) ? rows : [];
  const known = new Set(items.map((item) => item.id));
  const added = [];
  page.forEach((item) => {
    // 列表按 update_time 倒序：翻页期间有新消息的会话会跳到头部，offset 随之错位，
    // 下一页会带回已加载的条目——重复的直接丢弃，不能让侧栏出现两条一样的会话
    if (!known.has(item.id)) {
      known.add(item.id);
      added.push(item);
    }
  });
  return {
    items: items.concat(added),
    added,
    // 不满一页 = 没有更早的了；整页都是重复项 = offset 已错位到已加载区间，同样视为到底
    hasMore: page.length >= pageSize && added.length > 0
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeConversationPage };
}
if (typeof window !== 'undefined') {
  window.SXWSessionPage = { mergeConversationPage };
}
