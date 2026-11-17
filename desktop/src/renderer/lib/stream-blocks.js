/**
 * 文件：desktop/src/renderer/lib/stream-blocks.js
 * 职责：把流式回答切成「已闭合、可安全独立渲染的块」+「末尾还在增长的部分」。
 *
 * 为什么需要它：流式渲染每帧都对整条回答跑一次 Markdown 全量解析并整体替换 innerHTML，
 * 成本随长度平方增长，而且每帧重建全部节点会让用户手动展开的代码块回弹、选中的文字被清掉。
 * 切成「前缀块 + 末尾块」后，前缀块渲染一次即可缓存，每帧只重渲染末尾那一小段。
 *
 * 正确性优先：只有「换成独立渲染后视觉不变」的块才允许划进前缀；拿不准的一律留在末尾重渲染，
 * 最坏情况退化成本 == 全量重渲染（等于没优化），绝不会渲染错。
 */

// 围栏代码块：``` 或 ~~~（允许前导缩进与语言标记）
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
// 容器类块的起始行：列表 / 引用 / 表格。同种容器相邻时，分开渲染会多出间距或断成两个容器
const LIST_RE = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/;
const QUOTE_RE = /^\s{0,3}>/;
const TABLE_RE = /^\s{0,3}\|/;

function firstContentLine(text) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (line.trim() !== '') {
      return line;
    }
  }
  return '';
}

// 块类型：同类型的两个块相邻时不能各自独立渲染
function kindOf(text) {
  const line = firstContentLine(text);
  if (LIST_RE.test(line)) {
    return 'list';
  }
  if (QUOTE_RE.test(line)) {
    return 'quote';
  }
  if (TABLE_RE.test(line)) {
    return 'table';
  }
  return 'block';
}

/**
 * 按空行切块（围栏代码块里的空行不算边界）。
 * 每个块保留原文（含结尾空行），保证 closed.join('') + tail === text 恒成立。
 */
function splitRawBlocks(text) {
  const blocks = [];
  let buffer = '';
  let fence = '';
  // 保留行尾换行，拼接时才能无损还原
  for (const line of String(text || '').split(/(?<=\n)/)) {
    buffer += line;
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = '';
      }
      continue;
    }
    if (!fence && line.trim() === '') {
      blocks.push({ text: buffer, open: false });
      buffer = '';
    }
  }
  if (buffer) {
    blocks.push({ text: buffer, open: Boolean(fence) });
  }
  return blocks;
}

/**
 * 切成 { closed, tail }：
 * - closed：从头开始连续「可独立渲染」的块（每项是原文片段，已含结尾空行）
 * - tail：其余全部原文（包含正在增长的末块）
 * 不变量：closed.join('') + tail === text
 */
function splitMarkdownBlocks(text) {
  const source = String(text || '');
  const blocks = splitRawBlocks(source);
  if (blocks.length <= 1) {
    return { closed: [], tail: source };
  }
  // 前缀只能从前往后扩：一旦某块与后一块同属一个容器（列表/引用/表格）或本身未闭合，就停在它前面
  let cut = 0;
  while (cut < blocks.length - 1) {
    const block = blocks[cut];
    const next = blocks[cut + 1];
    if (block.open) {
      break;
    }
    const sameContainer = kindOf(block.text) !== 'block' && kindOf(block.text) === kindOf(next.text);
    if (sameContainer) {
      break;
    }
    cut += 1;
  }
  return {
    closed: blocks.slice(0, cut).map((item) => item.text),
    tail: blocks.slice(cut).map((item) => item.text).join('')
  };
}

// 顶层 const 在 classic script 里共享同一个全局词法作用域，两个 lib 都叫 api 会直接 SyntaxError
const streamBlocksApi = { splitMarkdownBlocks };
if (typeof window !== 'undefined') {
  window.SXWStreamBlocks = streamBlocksApi;
}
if (typeof module !== 'undefined') {
  module.exports = streamBlocksApi;
}
