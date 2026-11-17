#!/usr/bin/env node
/**
 * 桌面端自检用的假后端（mock server）
 *
 * 只服务 `npm run smoke`：按 README 的接口清单返回**固定**数据，不连数据库、不调真实模型，
 * 让 chat / stop / error / sessions / auth / enhance / rounds 这些场景在任何机器上都能复现——
 * 它们断言的是「收到固定回复文本、会话 id 恒为 12、匿名列表 2 条」这类确定性结果，
 * 真后端会返回真实模型内容与自增会话 id，断言必然不成立。
 *
 * 生产链路完全不走这里：桌面端正式启动连的是 backend/ 的真服务。
 * 用法：`node tools/mock-server.js --port 8123`（端口缺省 8010）
 *
 * 安全口径差异（重要）：本文件回的 `Access-Control-Allow-Origin: *` 是**刻意的宽松**，
 * 只为让 `file://` 页面在冒烟里跑通。真后端（backend/main.py）**没有任何 CORS 头，也不允许加 `*`**——
 * 匿名会话无需 token，一旦回 `*`，任意网页都能跨站读走本机全部会话。
 * 排障时不要把这里的写法搬到真后端。
 */
const http = require('http');

const DEFAULT_PORT = 8010;
const MOCK_TOKEN = 'mock-token-for-smoke';
const MOCK_CODE = '1234'; // 演示验证码，与 的演示码一致
const MOCK_PASSWORD = 'pass1234'; // 冒烟场景里注册与登录共用的密码
const CHAT_CONVERSATION_ID = 12; // 冒烟断言会话 id 恒为此值
// 1×1 透明 PNG：附件原文件接口的最小可用载荷（灯箱与缩略图只关心能否加载）
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2wAAAABJRU5ErkJggg==',
  'base64'
);

// 固定回复：一段话里同时具备加粗、标题、代码块、列表与「看起来像脚本」的文本，
// 用来验证 Markdown 渲染与转义（<script> 必须原样显示，不能被当成标签注入）
// 长代码块（20 行）用于验证「超过 16 行默认折叠 + 展开状态在重渲染后保持」
const LONG_CODE_LINES = Array.from({ length: 20 }, (item, index) => `const line${index + 1} = ${index + 1};`).join('\n');
const MOCK_REPLY = [
  'mock 流式回复：下面演示一次完整的 Markdown 渲染。',
  '\n\n**这是加粗**\n\n',
  '# 这是一级标题\n\n',
  '- 列表第一项\n',
  '- 列表第二项\n\n',
  '```python\nprint("这是一段代码")\n```\n\n',
  // 超过 16 行的长代码块：默认折叠，冒烟要断言「展开 → 文案变收起 → 重渲染后仍展开」
  '```js\n' + LONG_CODE_LINES + '\n```\n\n',
  // 表格与任务列表：AI 回答里的高频结构，渲染要单独断言
  '| 名称 | 数量 |\n',
  '| --- | --- |\n',
  '| 苹果 | 3 |\n',
  '| 香蕉 | 5 |\n\n',
  '- [x] 已完成项\n',
  '- [ ] 待办项\n\n',
  '转义演示：<script>alert(1)</script> 应当原样显示为文本。'
].join('');

// 会话数据：21 = 标题含「报」的那条（搜索场景用），22 = 有历史消息的那条
const nowSeconds = () => Math.floor(Date.now() / 1000);
const state = {
  anonymous: [
    { id: 21, title: '报销单怎么写', update_time: nowSeconds() - 60 },
    { id: 22, title: '周会纪要', update_time: nowSeconds() }
  ],
  owned: [], // 登录认领进来的匿名会话
  extraOwned: [{ id: 23, title: '登录后才看得到的旧会话', update_time: nowSeconds() - 3600 }],
  registered: new Set(),
  profiles: new Map(), // username -> { id, username, nickname, avatar }（改昵称后要能读回新值）
  account: '', // 最近一次登录/注册成功的账号：PATCH /me 用它定位改谁
  deleted: new Set()
};

// 昵称默认规则：与后端 core/user.py 的 _nickname 同源（邮箱取 @ 前、纯数字取后 4 位、其余用原串）
function nicknameOf(username) {
  if (username.includes('@')) {
    return username.split('@')[0];
  }
  return /^\d+$/.test(username) ? username.slice(-4) : username;
}

function profileOf(username, nickname) {
  const existed = state.profiles.get(username);
  if (existed) {
    return existed;
  }
  const profile = {
    id: 1,
    username,
    nickname: nickname || nicknameOf(username),
    avatar: ''
  };
  state.profiles.set(username, profile);
  return profile;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => resolve(''));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

// 契约里的错误形状与真后端一致：detail 优先，前端 readDetail 直接取它当中文提示
function sendError(res, status, message) {
  sendJson(res, status, { code: status, message, detail: message });
}

function isLoggedIn(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') === MOCK_TOKEN;
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // SSE 三件套：不缓存、不 buffering，否则前端收不到分块
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
}

// 分块写 SSE：每块之间停顿，前端才有「流式」效果可断言；客户端断开立刻停写
function streamChunks(res, chunks, intervalMs, tail) {
  let index = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) {
      return;
    }
    if (index >= chunks.length) {
      clearInterval(timer);
      tail();
      return;
    }
    res.write(`data: ${JSON.stringify({ content: chunks[index] })}\n\n`);
    index += 1;
  }, intervalMs);
  res.on('close', () => {
    stopped = true;
    clearInterval(timer);
  });
}

function finishSse(res) {
  res.write(`data: ${JSON.stringify({ conversation_id: CHAT_CONVERSATION_ID })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamReply(res, message) {
  startSse(res);
  // 错误场景：后端在流里回 error，前端据此渲染错误气泡 + 重试按钮
  if (message === 'error') {
    res.write(`data: ${JSON.stringify({ error: '模型调用失败' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  // 停止场景：慢速长流，给「点停止」留出时间窗
  const slow = message === 'slow';
  const chunks = MOCK_REPLY.match(/[\s\S]{1,3}/g) || [];
  streamChunks(res, chunks, slow ? 400 : 20, () => finishSse(res));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
  const pathname = url.pathname;
  const method = String(req.method || 'GET').toUpperCase();

  // 预检：页面是 file:// 协议，跨域请求都要先 OPTIONS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end();
    return;
  }

  if (pathname === '/api/v1/health') {
    // 与真后端同形状（backend/tests/test_health.py）：data 里缺字段时，
    // 冒烟里的「数据与备份」面板等于零覆盖，且 cleanupStale 会把 mock 当外部后端
    sendJson(res, 200, {
      code: 0,
      message: '服务正常',
      data: {
        managed: true,
        pid: process.pid,
        db: { backend: 'sqlite', ok: true, location: 'data/suixinwenda.db', connection: null }
      }
    });
    return;
  }

  if (pathname === '/api/v1/get_models' && method === 'GET') {
    // 真后端形状的裸对象：{models, default}
    sendJson(res, 200, { models: ['deepseek-flash', 'qwen-plus'], default: 'deepseek-flash' });
    return;
  }

  if (pathname === '/api/v1/chat' && method === 'POST') {
    const body = await readBody(req);
    let message = '';
    try {
      message = String((JSON.parse(body) || {}).message || '');
    } catch (error) {
      message = '';
    }
    streamReply(res, message);
    return;
  }

  if (pathname === '/api/v1/chat_upload' && method === 'POST') {
    await readBody(req); // 上传体（multipart）不解析，冒烟只验证链路走得通
    streamReply(res, '');
    return;
  }

  if (pathname === '/api/v1/send_code' && method === 'POST') {
    // 演示形态：验证码随响应回显（真后端由 DEMO_CODE_MODE 控制）。
    // 形状必须与真后端一致（裸对象）：套 data 会让 jsonPayload 的容错把契约差异盖住
    sendJson(res, 200, { code: MOCK_CODE, expires_in: 300 });
    return;
  }

  if (pathname === '/api/v1/register' && method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(body) || {};
    } catch (error) {
      payload = {};
    }
    const username = String(payload.username || '');
    const nickname = String(payload.nickname || '').trim();
    state.registered.add(username);
    state.account = username;
    const user = profileOf(username, nickname);
    // 注册即登录：真后端直接回令牌与 user（裸对象，不套 code/data）
    sendJson(res, 200, {
      access_token: MOCK_TOKEN,
      token_type: 'bearer',
      expires_in: 604800,
      user
    });
    return;
  }

  if (pathname === '/api/v1/login' && method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(body) || {};
    } catch (error) {
      payload = {};
    }
    const username = String(payload.username || '');
    if (String(payload.password || '') !== MOCK_PASSWORD || !state.registered.has(username)) {
      sendError(res, 401, '用户名或密码错误');
      return;
    }
    state.account = username;
    sendJson(res, 200, {
      access_token: MOCK_TOKEN,
      token_type: 'bearer',
      expires_in: 604800,
      user: profileOf(username)
    });
    return;
  }

  if (pathname === '/api/v1/me' && method === 'PATCH') {
    if (!isLoggedIn(req)) {
      sendError(res, 401, '登录状态无效，请重新登录');
      return;
    }
    const body = await readBody(req);
    let nickname = '';
    try {
      nickname = String((JSON.parse(body) || {}).nickname || '').trim();
    } catch (error) {
      nickname = '';
    }
    if (!nickname) {
      sendError(res, 422, '昵称须为 1-20 个字符');
      return;
    }
    // 冒烟只有一个账号：直接把最新昵称记在固定 account 上
    const profile = profileOf(state.account, '');
    profile.nickname = nickname;
    sendJson(res, 200, profile);
    return;
  }

  if (pathname === '/api/v1/login_by_code' && method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(body) || {};
    } catch (error) {
      payload = {};
    }
    if (String(payload.code || '') !== MOCK_CODE) {
      sendError(res, 400, '验证码错误或已失效');
      return;
    }
    const username = String(payload.username || '');
    const isNew = !state.registered.has(username);
    state.registered.add(username);
    state.account = username;
    sendJson(res, 200, {
      access_token: MOCK_TOKEN,
      token_type: 'bearer',
      expires_in: 604800,
      is_new_user: isNew,
      user: profileOf(username)
    });
    return;
  }

  if (pathname === '/api/v1/conversations' && method === 'GET') {
    const list = isLoggedIn(req) ? state.owned.concat(state.extraOwned) : state.anonymous;
    sendJson(res, 200, list.filter((item) => !state.deleted.has(item.id))); // 裸数组
    return;
  }

  if (pathname === '/api/v1/conversations/claim' && method === 'POST') {
    const body = await readBody(req);
    let ids = [];
    try {
      ids = (JSON.parse(body) || {}).conversation_ids || [];
    } catch (error) {
      ids = [];
    }
    let claimed = 0;
    ids.forEach((id) => {
      const index = state.anonymous.findIndex((item) => item.id === id);
      if (index >= 0) {
        state.owned.push(state.anonymous[index]); // 认领后归登录用户，匿名列表不再可见
        state.anonymous.splice(index, 1);
        claimed += 1;
      }
    });
    sendJson(res, 200, { claimed }); // 裸对象，与真后端一致
    return;
  }

  const messageMatch = /^\/api\/v1\/conversations\/(\d+)\/messages$/.exec(pathname);
  if (messageMatch && method === 'GET') {
    const id = Number(messageMatch[1]);
    if (id === 22) {
      sendJson(res, 200, [
        { role: 'user', content: '周会纪要怎么记？' },
        { role: 'assistant', content: '**历史消息**：这是带加粗的历史回复，用来验证历史渲染。' },
        // 带附件的两条历史消息：验证卡片渲染、文档正文预览与图片缩略图
        {
          role: 'user',
          content: '[上传文件] 会议纪要.md\n会议结论：本周五上线\n\n帮我总结',
          attachments: [
            { id: 91, name: '会议纪要.md', mime: 'text/markdown', size: 1024, kind: 'text', truncated: false }
          ]
        },
        {
          role: 'user',
          content: '[上传文件] 截图.png\n这是什么',
          attachments: [
            { id: 92, name: '截图.png', mime: 'image/png', size: 2048, kind: 'image', truncated: false }
          ]
        }
      ]);
      return;
    }
    sendJson(res, 200, [
      { role: 'user', content: '报销单怎么写？' },
      { role: 'assistant', content: '历史消息：按时间、事由、金额三段写就行。' }
    ]);
    return;
  }

  // 附件：文档正文（预览弹窗）与原始字节（灯箱 / 缩略图）
  const attachTextMatch = /^\/api\/v1\/attachments\/(\d+)\/text$/.exec(pathname);
  if (attachTextMatch && method === 'GET') {
    sendJson(res, 200, {
      id: Number(attachTextMatch[1]),
      name: '会议纪要.md',
      mime: 'text/markdown',
      size: 1024,
      kind: 'text',
      text: '会议结论：本周五上线\n负责人：小李',
      truncated: false
    });
    return;
  }

  const attachRawMatch = /^\/api\/v1\/attachments\/(\d+)$/.exec(pathname);
  if (attachRawMatch && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': MOCK_PNG.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(MOCK_PNG);
    return;
  }

  const memoryMatch = /^\/api\/v1\/conversations\/(\d+)\/memory$/.exec(pathname);
  if (memoryMatch && method === 'GET') {
    sendJson(res, 200, {
      messages: [
        { role: 'system', content: '自动总结摘要：用户在问报销与周报写法，偏好分点说明。' },
        { role: 'user', content: '报销单怎么写？' },
        { role: 'assistant', content: '可以按「时间 + 事由 + 金额」三段写；记忆里提到用户偏好分点。' },
        { role: 'assistant', content: '补充：向量数据库只用于相似历史召回，不存原始对话。' }
      ]
    });
    return;
  }

  const revertMatch = /^\/api\/v1\/conversations\/(\d+)\/revert$/.exec(pathname);
  if (revertMatch && method === 'POST') {
    // 回退一步：真后端取库里上一版内容，假后端固定回一段可断言的文本
    sendJson(res, 200, { id: 1, content: '上一版回答（mock）', model: 'deepseek-flash' });
    return;
  }

  const renameMatch = /^\/api\/v1\/conversations\/(\d+)$/.exec(pathname);
  if (renameMatch && method === 'PATCH') {
    const id = Number(renameMatch[1]);
    const body = await readBody(req);
    let title = '';
    try {
      title = (JSON.parse(body) || {}).title || '';
    } catch (error) {
      title = '';
    }
    const target = [...state.anonymous, ...state.owned, ...state.extraOwned].find((item) => item.id === id);
    if (!target) {
      sendError(res, 404, '会话不存在');
      return;
    }
    target.title = title;
    sendJson(res, 200, { id, title });
    return;
  }

  const deleteMatch = /^\/api\/v1\/conversations\/(\d+)$/.exec(pathname);
  if (deleteMatch && method === 'DELETE') {
    const id = Number(deleteMatch[1]);
    state.deleted.add(id);
    state.anonymous = state.anonymous.filter((item) => item.id !== id);
    state.owned = state.owned.filter((item) => item.id !== id);
    state.extraOwned = state.extraOwned.filter((item) => item.id !== id);
    sendJson(res, 200, { code: 0, message: '会话已删除', data: null });
    return;
  }

  sendError(res, 404, `假后端没有这个接口：${method} ${pathname}`);
});

function parsePort() {
  const flagIndex = process.argv.indexOf('--port');
  if (flagIndex > 0 && process.argv[flagIndex + 1]) {
    return Number(process.argv[flagIndex + 1]);
  }
  return Number(process.env.SMOKE_PORT || DEFAULT_PORT);
}

const port = parsePort();
server.listen(port, '127.0.0.1', () => {
  console.error(`[mock] 假后端已就绪：http://127.0.0.1:${port}/api/v1`);
});
server.on('error', (error) => {
  console.error(`[mock] 启动失败：${error.message}`);
  process.exit(1);
});

