/**
 * 文件：desktop/test/sse.test.js
 * 职责：SSE 解析边界——跨 chunk 半帧、单 chunk 多帧、[DONE] 终止、非法 JSON 帧。
 * 跑法：`cd desktop; npm test`（Node 22/24 均可，node --test 显式列文件）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { handleSseEvent, readSseStream } = require('../src/renderer/lib/sse.js');

function recorder() {
  const seen = [];
  return {
    seen,
    handlers: {
      onContent: (text) => seen.push(['content', text]),
      onConversation: (id) => seen.push(['conversation', id]),
      onError: (text) => seen.push(['error', text])
    }
  };
}

/** 造一个 Response 替身：body.getReader() 按给定 chunk 顺序吐出字节数组。 */
function responseFrom(chunks) {
  let cursor = 0;
  let cancelled = false;
  const reader = {
    read: async () => {
      if (cursor >= chunks.length) {
        return { done: true, value: undefined };
      }
      const value = chunks[cursor];
      cursor += 1;
      return { done: false, value };
    },
    cancel: async () => {
      cancelled = true;
    }
  };
  return {
    body: { getReader: () => reader },
    isCancelled: () => cancelled
  };
}

const encoder = new TextEncoder();

test('一帧被拆成两个 chunk 仍能正确拼回', async () => {
  const { seen, handlers } = recorder();
  const response = responseFrom([
    encoder.encode('data: {"content": "你'),
    encoder.encode('好"}\n\n')
  ]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['content', '你好']]);
});

test('一个 chunk 含多帧按顺序处理', async () => {
  const { seen, handlers } = recorder();
  const response = responseFrom([
    encoder.encode('data: {"content": "一"}\n\ndata: {"content": "二"}\n\ndata: {"content": "三"}\n\n')
  ]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['content', '一'], ['content', '二'], ['content', '三']]);
});

test('[DONE] 之后停止处理并取消读取', async () => {
  const { seen, handlers } = recorder();
  const response = responseFrom([
    encoder.encode('data: {"content": "一"}\n\ndata: [DONE]\n\ndata: {"content": "不该出现"}\n\n')
  ]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['content', '一']]);
  assert.strictEqual(response.isCancelled(), true, '拿到 [DONE] 应取消 reader');
});

test('非法 JSON 帧被忽略，后续帧照常处理', async () => {
  const { seen, handlers } = recorder();
  const response = responseFrom([
    encoder.encode('data: {不是 JSON}\n\ndata: {"content": "正常"}\n\n')
  ]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['content', '正常']]);
});

test('多字节中文被 chunk 边界切断时不乱码', async () => {
  const { seen, handlers } = recorder();
  const bytes = encoder.encode('data: {"content": "中文"}\n\n');
  const cut = 20; // 故意切在多字节字符中间
  const response = responseFrom([bytes.slice(0, cut), bytes.slice(cut)]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['content', '中文']]);
});

test('流结束前没有 \\n\\n 收尾时仍处理 buffer 里最后一帧', async () => {
  const { seen, handlers } = recorder();
  const response = responseFrom([encoder.encode('data: {"content": "尾帧"}')]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['content', '尾帧']]);
});

test('conversation_id 与 error 载荷都能被分派', async () => {
  const { seen, handlers } = recorder();
  const response = responseFrom([
    encoder.encode('data: {"conversation_id": 12}\n\ndata: {"error": "生成失败"}\n\n')
  ]);
  await readSseStream(response, handlers);
  assert.deepStrictEqual(seen, [['conversation', 12], ['error', '生成失败']]);
});

test('handleSseEvent 对空事件与非 data 行返回 true 且不回调', () => {
  const { seen, handlers } = recorder();
  assert.strictEqual(handleSseEvent('event: ping\nid: 1', handlers), true);
  assert.strictEqual(handleSseEvent('data:   ', handlers), true);
  assert.deepStrictEqual(seen, []);
});

test('handleSseEvent 遇到 [DONE] 返回 false', () => {
  const { handlers } = recorder();
  assert.strictEqual(handleSseEvent('data: [DONE]', handlers), false);
});

test('响应体不支持 getReader 时给出中文错误', async () => {
  await assert.rejects(
    () => readSseStream({ body: {} }, recorder().handlers),
    /不支持流式读取/
  );
});
