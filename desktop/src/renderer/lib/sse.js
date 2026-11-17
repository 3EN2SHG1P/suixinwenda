/**
 * 文件：desktop/src/renderer/lib/sse.js
 * 职责：SSE 帧解析与流读取——按 `\n\n` 切分、缓存跨 chunk 的半帧、非法帧忽略、[DONE] 停读。
 *
 * 为什么单独成文件：跨 chunk 拼半帧是最容易写错也最难用冒烟复现的一段
 * （一帧被切成两个 chunk、一个 chunk 含多帧），拆成纯函数后可以用 `node --test` 直接压边界。
 * 只依赖 TextDecoder：Node 22+ 与浏览器都有全局实现。
 *
 * 双出口：页面里按 classic script 加载（挂 window.SXWSse），单测里 require（挂 module.exports）。
 */

// 按 `\n\n` 切分 SSE，缓存最后一段（可能被切断），只处理 `data: ` 开头，收到 [DONE] 立即停读
function handleSseEvent(rawEvent, handlers) {
  const dataLines = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (!dataLines.length) {
    return true;
  }
  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return true;
  }
  if (payloadText === '[DONE]') {
    return false;
  }
  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    return true;
  }
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  if (typeof payload.content === 'string' && payload.content) {
    handlers.onContent(payload.content);
  }
  if (payload.conversation_id) {
    handlers.onConversation(payload.conversation_id);
  }
  if (payload.error) {
    handlers.onError(String(payload.error));
  }
  return true;
}

async function readSseStream(response, handlers) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('当前环境不支持流式读取，请升级桌面端');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  while (!finished) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!handleSseEvent(rawEvent, handlers)) {
        finished = true;
        break;
      }
      boundary = buffer.indexOf('\n\n');
    }
  }

  // 收尾 flush：最后一包若正好切在多字节字符中间，剩余半个字符还压在 decoder 里，
  // 不 flush 就会丢掉末尾半个字（中文回复里表现为最后一个字变成乱码）
  buffer += decoder.decode();
  if (!finished && buffer.trim()) {
    finished = !handleSseEvent(buffer, handlers);
  }
  if (finished && typeof reader.cancel === 'function') {
    try {
      await reader.cancel();
    } catch (error) {
      // 已拿到结束标记，取消读取失败可忽略
    }
  }
}

// 顶层 const 在 classic script 里共享同一个全局词法作用域，两个 lib 都叫 api 会直接 SyntaxError
const sseApi = { handleSseEvent, readSseStream };
if (typeof window !== 'undefined') {
  window.SXWSse = sseApi;
}
if (typeof module !== 'undefined') {
  module.exports = sseApi;
}
