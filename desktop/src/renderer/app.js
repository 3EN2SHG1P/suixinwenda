/**
 * 文件：desktop/src/renderer/app.js
 * 职责：主窗口渲染进程逻辑（只承载聊天与导航），按编号段落组织：
 *      1 常量与元素引用 / 2 主题 / 3 窗口控制 / 4 连接状态与模型列表 / 5 Markdown 渲染 /
 *      6 消息区渲染（含消息操作条 / 滚动跟随 / 事件委托） / 7 发送与流式对话 / 8 输入区交互 /
 *      9 桌面增强入口（设置 / 记忆 / 附件 / 导出 / 菜单快捷键） /
 *      10 提示条 / 11 会话列表与搜索 / 12 会话切换·删除·新建 / 13 二次确认窗口 / 14 登录注册与用户卡片 /
 *      15 冒烟自检入口（仅冒烟启动时动态加载 smoke.js）/ 16 启动。
 *
 * 窗口口径：设置 / 历史 / 预览 / 灯箱 / 登录 / 昵称 / 模型 / 存储 / 备份 / 恢复 / 确认 / 重命名
 *      全部是独立子窗口（界面在 renderer/views/*.js，窗口能力在 app-windows.js + app-window.js）。
 *      主窗口只做两件事：打开窗口、认领回传结果；页面里不再有任何遮罩层。
 * 口径：接口路径与 SSE 载荷以 README 的接口清单为准；超时、轮询、字数上限等数值集中在
 *      本文件顶部常量区，改参数只改那里。
 */

// ===== 1. 常量与元素引用 =====
const API_PREFIX = '/api/v1'; // 后端统一前缀
const MAX_MESSAGE_LENGTH = 4000; // 单条消息字数上限，与后端一致；字数提示格式 `n / 4000`
const REQUEST_TIMEOUT = 30000; // 普通请求超时（毫秒）
const MODELS_TIMEOUT = 8000; // 拉模型列表超时
const CONNECT_TIMEOUT = 3000; // 连接状态探测超时，超时即判未连接
const CONNECT_POLL = 15000; // 在线时的连接轮询间隔
const CONNECT_POLL_OFFLINE = 5000; // 离线时缩短重连间隔，让界面自己活起来
const MEMORY_TIMEOUT = 60000; // 记忆查询超时
const TOAST_DURATION_MS = 4000; // 提示条显示时长（错误常驻，手动关闭）
const INPUT_MIN_HEIGHT = 34; // 输入框最小高度（px）：对齐效果图单行输入行
const INPUT_MAX_HEIGHT = 160; // 输入框随内容增高的上限（px）
const SKELETON_ROWS = 3; // 会话列表加载骨架条数
const SCROLL_BOTTOM_GAP = 80; // 距底小于该值视为「在底部」，流式时继续自动跟随
const SEARCH_DEBOUNCE_MS = 120; // 搜索输入防抖：避免每敲一个字就重建整份会话列表
const MAX_FOLD_CHARS = 1500; // 用户消息超过该字数才折（只针对附件抽取正文；模型输出永不折）
const DRAFT_PREFIX = 'chat_draft_'; // 每个会话各存一份未发送草稿
const DRAFT_SAVE_DELAY = 300; // 停止输入多久后落盘
const MAX_LOCAL_BYTES = 10 * 1024 * 1024; // 单文件上限（与后端 MAX_UPLOAD_BYTES 同源，提前拦截）
const MAX_ATTACHMENTS = 9; // 一次最多几个附件（与后端 MAX_UPLOAD_FILES 同源）
const MAX_TOTAL_LOCAL_BYTES = 30 * 1024 * 1024; // 附件合计上限（与后端 MAX_TOTAL_BYTES 同源）
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';
// 正文字号三档（设置 → 外观）；只改 :root 的 font token，不动布局尺寸
const FONT_SCALES = ['small', 'normal', 'large'];
const FONT_NORMAL = 'normal';
const DEFAULT_CONFIG = { apiBase: 'http://127.0.0.1:8010', theme: THEME_LIGHT, fontScale: FONT_NORMAL };
// 消息操作条图标：唯一出处在 ui-bits.js（与通知图标同一套 1.7 描边），这里只取引用
const MSG_ICONS = (window.SXW_UI && window.SXW_UI.ACTION_ICONS) || { copy: '', speak: '', regen: '' };
// 朗读最短正文：太短的回复没必要念，按钮会做禁用提示而不是直接消失（位置稳定）
const SPEAK_MIN_CHARS = 80;
const SPEAK_MAX_CHARS = 12000;
// 登录令牌与登录账号不再落 localStorage：改由主进程用 safeStorage 加密写 userData/auth.bin，
// 页面只通过 preload 的 readAuth / writeAuth / clearAuth 取值（见 main.js 段落 5c）。
// 会话列表分页每页条数：与后端 core.history.CONVERSATIONS_DEFAULT_LIMIT 同源（后端不传就是 100），
// 桌面端显式传一页而不是拿上限值，否则首屏直接拉满就失去分页意义
const CONVERSATIONS_PAGE_SIZE = 100;
// 认领批量：与后端 core.history.CLAIM_MAX_IDS（schemas 的 max_length 也取它）同源，
// 超过这个数整批 422 一条都认领不回来，所以必须分批发
const CLAIM_BATCH_SIZE = 50;
// 会话内消息每页条数：与后端 core.history.MESSAGES_DEFAULT_LIMIT 同源
const MESSAGES_PAGE_SIZE = 50;
// 登录时扫匿名会话的最大页数：防止后端行为异常时无限翻页（500 条足够覆盖单人本机场景）
const ANONYMOUS_SCAN_MAX_PAGES = 5;
// 登录类接口自己会回 401（账号或密码错误），不能当成「登录态失效」去做全局清理
const AUTH_PATHS = ['/login', '/register', '/send_code', '/login_by_code'];

const dom = {};
let appConfig = Object.assign({}, DEFAULT_CONFIG);
let toastTimer = null;
let connectPollTimer = null; // 自动重连定时器
let searchTimer = null; // 会话搜索防抖
let draftTimer = null; // 草稿落盘防抖
let scrollFrame = 0; // 滚动到底的帧节流句柄
let connectingPromise = null; // 连接检测互斥（自动轮询 / 手动重试 / 保存设置会撞车，后来者复用同一次请求）
let lastConnectedToastAt = 0; // 「后端已连接」的节流时间戳：恢复连接时只提示一次
let conversationSeq = 0; // 会话切换请求序号：慢请求回来时若已切走就丢弃
let msgMoreButton = null; // 消息区顶部的「加载更早」按钮（随会话切换销毁重建）

// 运行时状态（连接 / 模型 / 当前会话 / 生成中）
const state = {
  online: null, // null=检测中 / true=已连接 / false=离线
  // 上一次真正画到界面上的连接态（`online|retrying`）：轮询结果没变就别再重绘侧栏/横幅，
  // 否则每 5~15 秒都会重建一次占位，看起来像页面在刷新
  connectionPaint: '',
  connectAttempts: 0, // 离线以来的自动重连次数（离线横幅上显示，）
  retrying: false, // 手动「立即重试」进行中：界面显示连接中动画
  models: [],
  modelsChecked: false, // 模型列表是否已成功拉到：失败时置回 false，下一轮轮询会再试（不会因「0 个模型」禁用发送）
  model: '',
  defaultModel: '', // 后端声明的默认模型名（用于能力回退）
  conversationId: null,
  // 当前会话的消息分页游标：切会话时必须整体重置，否则会带着 A 会话的「还有更早」跑到 B
  messagesHasMore: false,
  messagesOldestId: 0,
  messagesLoadingMore: false,
  conversations: [],
  conversationsLoaded: false,
  conversationsHasMore: false, // 后端还有更早的会话（首屏返回满一页时为 true）
  conversationsLoadingMore: false, // 「加载更早」请求进行中（按钮禁用态）
  conversationsPaged: false, // 是否点过「加载更早」：决定要不要显示「没有更早的会话了」
  searchKeyword: '',
  // 存储 / 备份 / 恢复 / 模型的状态全部在各自窗口里（views/*.js），主窗口只留「后端是否在忙」
  toolBusy: false, // 长任务（备份/导出/清除/恢复/换库）执行中：挡住发送入口
  toolBusyText: '', // 挡住发送的原因文案（由主进程广播带下来）
  generating: false,
  stoppedByUser: false, // 本轮是用户点「停止」才断的（区分后端断开导致的 AbortError）
  controller: null,
  streamSeq: 0, // 本轮生成的序号：上一轮迟到的回调一律不许再动界面（防止旧流把新气泡的内容吞掉）
  lastMessage: '',
  emptyHidden: false,
  // 登录态：昵称与头像一律用后端下发的值，前端不再按账号规则自己推导
  auth: { token: '', id: 0, username: '', nickname: '', avatar: '' },
  anonymousConversationIds: [], // 未登录时能看到的匿名会话 id，登录后用于自动认领
  attachments: [], // 待发送附件列表（可多选，最多 MAX_ATTACHMENTS 个）
  lastAttachments: [], // 最近一次发送用的附件列表，供错误重试复用
  collapsedGroups: [], // 已折叠的会话分组名（只记内存，重启复位）
  searchNav: -1, // 搜索时键盘高亮到第几条（-1 = 未进入键盘导航）
  overLimitNotified: false, // 超字数提示只在刚超限时弹一次
  menuActions: [] // 原生菜单/快捷键下发的动作记录（冒烟断言用）
};

// 存储、模型、备份、恢复的界面与执行全部在独立窗口（renderer/views/*.js）里：
// 主窗口只保留聊天与导航，不再加载 storage.js / models.js，避免同一套表单存在两份实现。

// 连接域：侧栏三态（真实列表 / 离线占位 / 骨架）与数据源切换后的复位都收在 connection.js，
// app.js 只保留「什么时候调它」，避免同一种清理逻辑在四五个入口各写一遍
const connection = window.SXWConnection.createConnectionDomain({
  state,
  dom,
  skeletonRows: SKELETON_ROWS,
  renderSessionList,
  showEmptyState,
  runAsync,
  checkConnection,
  loadModels,
  // 换库/恢复/清除/换地址时必须先掐掉正在跑的流：
  // 气泡马上会被清空，旧流却还在往已脱离文档的节点写，回答直接丢掉
  stopGenerating,
  getConfig: () => appConfig,
  mergeConfig: (conf) => (appConfig = Object.assign({}, appConfig, conf))
});

// 事件回调里的异步操作统一走它：出错给中文提示 + 控制台原文，不留下没人接的 Promise
async function runAsync(label, task) {
  try {
    return await task();
  } catch (error) {
    console.error(`[${label}] 失败`, error);
    showToast(`${label}失败，请重试`);
    return null;
  }
}

function cacheDom() {
  const ids = [
    'btn-minimize',
    'btn-maximize',
    'btn-close',
    'btn-sidebar-collapse',
    'btn-sidebar-expand',
    'sidebar-resizer',
    'chat-title',
    'btn-new-chat',
    'input-search',
    'session-list',
    'session-empty',
    'user-card',
    'user-avatar',
    'user-name',
    'user-sub',
    'user-menu',
    'btn-rename-user',
    'login-hint',
    'btn-logout',
    'btn-settings',
    'offline-banner',
    'offline-text',
    'btn-offline-retry',
    'select-model',
    'model-select-label',
    'model-select-list',
    'conn-text',
    'btn-memory',
    'btn-chat-search',
    'btn-theme',
    'btn-more',
    'more-menu',
    'message-list',
    'btn-scroll-bottom',
    'chat-search',
    'chat-search-input',
    'chat-search-count',
    'chat-search-prev',
    'chat-search-next',
    'chat-search-close',
    'empty-state',
    'empty-badge',
    'empty-badge-text',
    'attach-bar',
    'input-message',
    'btn-attach',
    'btn-send',
    'counter',
    'disclaimer',
    'toast',
    'toast-stack',
    'session-menu',
    'session-menu-rename',
    'session-menu-delete',
    'model-banner',
    'model-banner-open'
  ];
  ids.forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

// ===== 2. 主题 =====
// 主题卡在设置窗口里，高亮由 views/settings.js 自己维护；主窗口只负责应用（applyTheme）
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === THEME_DARK ? THEME_DARK : THEME_LIGHT;
}

function pickInitialTheme(queryTheme) {
  if (queryTheme === THEME_LIGHT || queryTheme === THEME_DARK) {
    return queryTheme;
  }
  return appConfig.theme;
}

// 当前生效主题（`data-theme` 是深色样式的唯一开关）
function currentTheme() {
  return document.documentElement.dataset.theme === THEME_DARK ? THEME_DARK : THEME_LIGHT;
}

// 字号：设置窗口写盘后由主进程广播回来，主窗口只负责应用
function applyFontScale(scale) {
  const next = FONT_SCALES.includes(scale) ? scale : FONT_NORMAL;
  document.documentElement.dataset.font = next;
}

// 主题切换：立即生效 + 记进配置文件（重启保持），并给中文提示
async function toggleTheme() {
  const next = currentTheme() === THEME_DARK ? THEME_LIGHT : THEME_DARK;
  applyTheme(next);
  appConfig.theme = next;
  if (window.desktopBridge) {
    await window.desktopBridge.writeConfig({ theme: next });
  }
  notify(
    next === THEME_DARK ? '已切换到深色主题' : '已切换到浅色主题',
    '偏好已保存，下次启动保持这一套'
  );
}

// ===== 3. 窗口控制（统一走 preload 暴露的 desktopBridge） =====
function bindWindowControls() {
  const bridge = window.desktopBridge;
  if (!bridge) {
    return;
  }
  // 点完主动 blur：窗口最小化/恢复后 Chromium 会把残留焦点按 :focus-visible 重绘，
  // 表现成「这个按钮一直亮着紫色边框」
  const bind = (id, action) => {
    const button = dom[id];
    button.addEventListener('click', () => {
      action();
      button.blur();
    });
  };
  bind('btn-minimize', () => bridge.minimize());
  bind('btn-maximize', () => bridge.toggleMaximize());
  bind('btn-close', () => bridge.close());
  bridge.onMaximizedChanged((maximized) => {
    dom['btn-maximize'].classList.toggle('is-maximized', Boolean(maximized));
  });
}

// ===== 4. 连接状态与模型列表（直连后端，不经过主进程） =====
function apiUrl(path) {
  return `${String(appConfig.apiBase || '').replace(/\/+$/, '')}${API_PREFIX}${path}`;
}

// 登录后自动携带令牌；未登录即匿名请求
function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (state.auth.token) {
    headers.Authorization = `Bearer ${state.auth.token}`;
  }
  return headers;
}

// 带超时的请求（底层：requestJson 与健康检查用；流式对话超时由用户点「停止」控制）
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs || REQUEST_TIMEOUT);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } finally {
    window.clearTimeout(timer);
  }
}

// 统一取中文错误原因：detail 可能是字符串或数组
async function readDetail(response) {
  try {
    const body = await response.json();
    const detail = body && body.detail;
    if (Array.isArray(detail)) {
      const first = detail[0] || {};
      // pydantic 的 ValueError 会带 "Value error, " 前缀，显示给用户前去掉
      return first.msg ? String(first.msg).replace(/^Value error,\s*/, '') : `请求失败（${response.status}）`;
    }
    if (typeof detail === 'string' && detail) {
      return detail;
    }
    if (body && typeof body.message === 'string' && body.message) {
      return body.message;
    }
    return `请求失败（${response.status}）`;
  } catch (error) {
    return `请求失败（${response.status}）`;
  }
}

// 登录态失效提示只弹一次：并发请求同时 401 时，否则会连叠好几条相同的 toast
let authExpiredNotified = false;

// 令牌失效的唯一处理入口：清本地登录态 + 提示一次。调用方只负责降级为匿名继续跑
function noteAuthExpired() {
  clearAuth(false);
  if (authExpiredNotified) {
    return;
  }
  authExpiredNotified = true;
  notify('登录已过期', '已退回访客模式，重新登录后会话仍归你', 'warn');
}

// 普通 JSON 接口的统一入口：超时 + 鉴权头 + 中文错误 + 空响应兜底，调用方只关心数据
// options: { method, json, timeout }；401 在这里统一清登录态，调用方只需按匿名降级
async function requestJson(path, options) {
  const opts = options || {};
  const headers = opts.json === undefined ? authHeaders() : authHeaders({ 'Content-Type': 'application/json' });
  const response = await fetchWithTimeout(
    apiUrl(path),
    {
      method: opts.method || 'GET',
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json)
    },
    opts.timeout || REQUEST_TIMEOUT
  );
  if (!response.ok) {
    const error = new Error(await readDetail(response));
    error.status = response.status;
    // 令牌失效必须在入口处理：只在某个接口里清理，其余接口会一直拿着废令牌 401，
    // 用户看到的是「发消息失败、改名失败、删除失败」而不知道要重新登录
    if (response.status === 401 && state.auth.token && !AUTH_PATHS.includes(path)) {
      noteAuthExpired();
    }
    throw error;
  }
  // DELETE 等接口可能没有响应体：空文本按 null 返回，不抛 JSON 解析错
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/**
 * 取接口返回的载荷：真后端直接回对象/数组（如 /login 回 {access_token,...}），
 * 假后端与 /health 用 {code, message, data} 包裹。
 *
 * 为什么要有这一层：以前只在少数调用点写 body.data，真后端没有这一层时拿到的就是 {}，
 * 表现为「登录成功却不生效 / 提示登录响应异常」这种静默失败。两种形状都在这里抹平。
 */
function jsonPayload(body) {
  // 只认「code + data」同时存在才算包裹层：避免把业务对象里恰好叫 data 的字段当外壳拆掉
  if (body && typeof body === 'object' && !Array.isArray(body) && 'code' in body && 'data' in body) {
    return body.data;
  }
  return body;
}

function setConnection(online) {
  // 幂等：连接态与「重试中」都没变时直接返回。轮询每轮都会调到这里，之前没有任何早退，
  // 于是 updateOfflineBanner / refreshSessionPlaceholder 每轮都重画一次侧栏占位
  const paint = `${online === null ? 'unknown' : online ? 'online' : 'offline'}|${state.retrying ? 'retry' : 'idle'}`;
  if (state.online === online && state.connectionPaint === paint) {
    return;
  }
  state.connectionPaint = paint;
  const wasOffline = state.online === false;
  state.online = online;
  // 连接状态点与设置窗口里的那套 UI 已经随设置一起搬走；主窗口只留左下角的连接胶囊
  const connText = dom['conn-text'];
  connText.textContent = state.retrying ? '连接中…' : online === null ? '检测中…' : online ? '已连接' : '离线';
  connText.title = online ? '点击重新检测' : '点击重新检测后端连接';
  // 骨架条是否跑跟随连接状态：离线 / 检测中 = 静态条，别一直闪
  connection.updateAnimation(online === true);
  // 底部工具坞的连接状态胶囊与状态点同色
  connText.classList.remove('is-online', 'is-offline', 'is-unknown');
  connText.classList.add(online === null ? 'is-unknown' : online ? 'is-online' : 'is-offline');
  // 离线横幅与侧栏占位随连接状态刷新
  updateOfflineBanner();
  connection.refreshPlaceholder();
  // 刚从离线恢复：只有列表本来就是空的才重拉，避免「恢复连接」把已有侧栏整块重建（看起来像刷新）
  if (online === true && wasOffline) {
    if (!state.conversations.length) {
      state.conversationsLoaded = false;
    }
    reportConnected();
  }
}

/** 恢复连接的提示只发一次：setConnection 与手动重试收尾都会走到这里 */
function reportConnected() {
  const now = Date.now();
  if (now - lastConnectedToastAt < 3000) {
    return;
  }
  lastConnectedToastAt = now;
  notify('后端已连接', '历史会话与模型列表已就绪', 'ok');
}

async function checkConnection() {
  // 自动轮询、手动重试、设置保存三处都会调：并发时不重复发请求，后来者直接复用同一次结果。
  // 早先这里是「并发就 return state.online」——手动重试恰好撞上轮询时会拿到 null，
  // 于是界面停在「检测中」、轮询又各自重排，看起来就是状态不统一、页面反复刷新
  if (connectingPromise) {
    return connectingPromise;
  }
  connectingPromise = (async () => {
    try {
      const response = await fetchWithTimeout(apiUrl('/health'), { method: 'GET' }, CONNECT_TIMEOUT);
      const body = await response.json();
      const online = Boolean(response.ok && body && body.code === 0);
      state.connectAttempts = online ? 0 : state.connectAttempts + 1;
      setConnection(online);
      if (online) {
        // 用「是否成功拉到」而不是「是否为空」：模型被删空后，用后者会让每轮轮询都重拉一次模型并重画下拉；
        // 但失败必须回滚标志，否则后端重启那一轮的失败会把列表锁死在「暂无模型」
        if (!state.modelsChecked) {
          await loadModels({ quiet: true });
        }
        // 是否算「已加载」由 loadConversations 按请求结果自己决定：
        // 以前在这里先置 true 再发请求，首次失败后就再也不会重拉了
        if (!state.conversationsLoaded) {
          await loadConversations({ quiet: true });
        }
      }
      return online;
    } catch (error) {
      state.connectAttempts += 1;
      setConnection(false);
      return false;
    }
  })();
  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

// 离线横幅——后端没起时把「在重连」说清楚，并给一键重试（不做成死页）
// 手动重试期间横幅就地切「连接中 + 旋转圈」，让用户看得见它在试
function updateOfflineBanner() {
  const banner = dom['offline-banner'];
  if (!banner) {
    return;
  }
  if (!state.retrying && state.online !== false) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const btn = dom['btn-offline-retry'];
  if (state.retrying) {
    dom['offline-text'].textContent = '正在连接后端，请稍候…';
    btn.textContent = '连接中…';
    btn.classList.add('is-spinning');
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.classList.remove('is-spinning');
  btn.textContent = '立即重试';
  const round = Math.max(1, state.connectAttempts);
  dom['offline-text'].textContent = `后端连接失败，正在自动重连（第 ${round} 次，每 ${CONNECT_POLL_OFFLINE / 1000} 秒一次）`;
}

// 手动重试：离线横幅 / 顶部状态点 / 底部「离线」胶囊 / 侧栏占位四处共用
async function retryConnection() {
  if (state.retrying) {
    return; // 已经在连了，别重复触发
  }
  const wasOffline = state.online === false;
  state.retrying = true;
  state.connectAttempts = 0;
  // 手动重试期间不让自动轮询插队：否则两次检测会互相覆盖状态
  window.clearTimeout(connectPollTimer);
  setConnection(null); // 先切「连接中」，动画立刻跑起来再等结果
  await checkConnection();
  state.retrying = false;
  setConnection(state.online); // 收尾刷新：去掉连接中样式，落回真实状态
  if (state.online === true && wasOffline) {
    reportConnected();
  }
  scheduleConnectPoll();
}

// 自动重连：在线 15s 一轮、离线 5s 一轮（递归 setTimeout，间隔随状态变化）
function scheduleConnectPoll() {
  window.clearTimeout(connectPollTimer);
  const delay = state.online === true ? CONNECT_POLL : CONNECT_POLL_OFFLINE;
  connectPollTimer = window.setTimeout(async () => {
    // 手动重试正在进行：这一轮让给它，等重试自己收尾后再排下一轮
    if (!state.retrying) {
      await checkConnection();
    }
    scheduleConnectPoll();
  }, delay);
}

// 主进程在托管后端就绪时会推一次：主窗口通常比后端先加载完，不接这条事件
// 用户就要白等一轮离线轮询才看到「已连接」。连不上仍走原来的离线逻辑
function bindBackendReady() {
  if (!window.desktopBridge || typeof window.desktopBridge.onBackendReady !== 'function') {
    return;
  }
  window.desktopBridge.onBackendReady(async () => {
    await checkConnection();
    // 状态刚变过：按最新结果重排下一轮，别沿用启动那一刻的 5 秒离线间隔
    scheduleConnectPoll();
  });
}

async function loadModels(options) {
  const quiet = Boolean(options && options.quiet);
  try {
    const body = await requestJson('/get_models', { timeout: MODELS_TIMEOUT });
    // 修「暂无模型」：真后端 返回裸 {models, default}；假后端包 {code, data:{...}}，两种都兼容
    const raw = body && typeof body === 'object' ? body : {};
    const data = Array.isArray(raw.models) ? raw : raw.data || {};
    // 新后端返回能力对象，旧后端/假后端返回名字数组：两种都吃
    const models = (Array.isArray(data.models) ? data.models : []).map((item) =>
      typeof item === 'string'
        ? { name: item, vision: true, reasoning: false, speed: 'fast' }
        : { vision: true, reasoning: false, speed: 'fast', ...item }
    );
    state.models = models;
    state.modelsChecked = true;
    state.defaultModel = data.default || '';
    // 传当前选择而不是空串：以前每次刷新都把用户选的模型悄悄重置成「默认模型」，模型增删后也一样
    renderModelSelect(state.model);
    // 没有模型时只留顶部横幅（renderModelSelect 已负责显隐），同一个信息不再弹一遍 toast
  } catch (error) {
    state.models = [];
    // 失败不能置 true：模型保存/删除会重启后端约 2 秒，那一次请求必然失败，
    // 置 true 就等于把「暂无模型」锁死到下次重启应用。置 false 让下一轮轮询再试
    state.modelsChecked = false;
    renderModelSelect('');
    // 连不上时离线横幅已经说明原因，再弹一条就是重复；静默轮询失败也不弹
    if (!quiet && state.online !== false) {
      showToast(error && error.message ? error.message : '请检查后端服务是否已启动', {
        title: '模型列表获取失败',
        type: 'error'
      });
    }
  }
  // 模型数量变化会影响「能不能发」：删空后发送键要立刻禁用
  setGenerating(state.generating);
}

// 自绘模型下拉（原生 select 弹层无法美化；点选即更新 state.model——此前 select 从未绑定过 change，选了也不生效）
function renderModelSelect(selectedValue) {
  // 选中的模型可能已被删除、或换了后端不再存在：只有仍在列表里才保留，否则落回「默认模型」
  const keep = selectedValue && state.models.some((item) => item.name === selectedValue) ? selectedValue : '';
  state.model = keep;
  const list = dom['model-select-list'];
  list.innerHTML = '';
  // 下拉显示用户填的显示名（label），但提交给后端的仍是注册表键（name）
  const options = [{ value: '', text: state.models.length ? '默认模型' : '暂无模型' }].concat(
    state.models.map((item) => ({ value: item.name, text: String(item.label || item.name) }))
  );
  options.forEach((opt) => {
    const item = document.createElement('li');
    item.className = 'model-option' + (opt.value === state.model ? ' is-selected' : '');
    item.dataset.value = opt.value;
    item.textContent = opt.text;
    list.appendChild(item);
  });
  // 标签显示「实际会用的模型名」而不是抽象的「默认模型」：后端给了默认模型就露名字（效果图：deepseek-flash）
  const effective = state.model || state.defaultModel;
  const effectiveOption = options.find((opt) => opt.value && opt.value === effective);
  const current = options.find((opt) => opt.value === state.model) || options[0];
  dom['model-select-label'].textContent = effectiveOption ? effectiveOption.text : current.text;
  // 没有可用模型时给横幅入口：离线时由 offline-banner 负责，避免两条横幅一起压过来
  dom['model-banner'].hidden = state.models.length > 0 || state.online === false;
  syncAttachAvailability();
}

// 当前生效模型的能力（未指定时用后端给的默认模型）
function currentModelCapability() {
  const fallback = state.models.find((item) => item.name === state.defaultModel) || state.models[0];
  const picked = state.model ? state.models.find((item) => item.name === state.model) : null;
  return picked || fallback || { name: '', vision: true, reasoning: false, speed: 'fast' };
}

// 不支持视觉的模型直接禁用附件入口，而不是让用户传上去再失败
function syncAttachAvailability() {
  const button = dom['btn-attach'];
  if (!button) {
    return;
  }
  const capability = currentModelCapability();
  const disabled = capability.vision === false;
  button.disabled = disabled;
  button.title = disabled
    ? `${capability.name || '当前模型'} 不支持图片与文件，请先在输入坞右侧切换模型`
    : '上传附件（图片 / 文档，可多选）';
}

function bindModelSelect() {
  const select = dom['select-model'];
  const list = dom['model-select-list'];
  const setOpen = (open) => {
    select.classList.toggle('is-open', open);
    list.hidden = !open;
    select.setAttribute('aria-expanded', String(Boolean(open))); // 读屏要知道下拉是开还是关
    if (open) {
      // 打开时把光标放到当前选项上，键盘用户接着用 ↑↓ 就能选
      const options = Array.from(list.querySelectorAll('.model-option'));
      const active = options.findIndex((item) => item.classList.contains('is-selected'));
      options.forEach((item, index) => item.classList.toggle('is-current', index === active));
    }
  };

  // 键盘操作：↑↓ 移动、Enter 选择、Esc 收起（原生 select 能做的，自绘控件也得有）
  select.addEventListener('keydown', (event) => {
    const options = Array.from(list.querySelectorAll('.model-option'));
    if (!options.length) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (list.hidden) {
        setOpen(true);
        return;
      }
      const cursor = options.find((item) => item.classList.contains('is-current')) || options[0];
      renderModelSelect(cursor.dataset.value || '');
      setOpen(false);
      return;
    }
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) {
        setOpen(true);
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const current = options.findIndex((item) => item.classList.contains('is-current'));
      const next =
        current < 0 ? (step > 0 ? 0 : options.length - 1) : (current + step + options.length) % options.length;
      options.forEach((item, index) => item.classList.toggle('is-current', index === next));
      options[next].scrollIntoView({ block: 'nearest' });
    }
  });
  select.addEventListener('click', (event) => {
    const option = event.target.closest('.model-option');
    if (option) {
      renderModelSelect(option.dataset.value || '');
      setOpen(false);
      return;
    }
    setOpen(list.hidden);
  });
  document.addEventListener('click', (event) => {
    if (!select.contains(event.target)) {
      setOpen(false);
    }
  });
}

// ===== 5. Markdown 渲染 ====
// 实现已整体搬到 renderer/lib/markdown.js（index.html 在本文件之前按 classic script 加载），
// 拆出去是为了能在 Node 里用 node --test 直接压 XSS 负面用例：本文件顶层就 bootstrap，Node 里跑不了。
// 页面里统一通过 SXWMarkdown.xxx 调用；expandedCode 是同一个 Set 引用，展开状态不会因重渲染丢失。

// ===== 6. 消息区渲染（用户右侧气泡 / AI 左侧气泡 / 错误气泡 / 浅色提示行） =====
function markEmptyHidden() {
  if (state.emptyHidden) {
    return;
  }
  setEmptyStateVisible(false);
}

function isNearBottom() {
  const list = dom['message-list'];
  return list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_GAP;
}

function updateScrollButton() {
  const button = dom['btn-scroll-bottom'];
  if (button) {
    button.hidden = isNearBottom();
  }
}

// 滚动到底：一帧内合并多次请求（流式每个 chunk 都会调），用户上滑阅读时不抢滚动
function scrollToBottom(force) {
  if (!force && !isNearBottom()) {
    updateScrollButton();
    return;
  }
  if (scrollFrame) {
    return;
  }
  const list = dom['message-list'];
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    list.scrollTop = list.scrollHeight;
    if (!force) {
      updateScrollButton();
      return;
    }
    // 手动「回到底部」：下一帧再校一次。图片刚加载、流式刚好追加都会在同一帧把高度撑大，
    // 只滚一次会出现「按钮消失但没到底」
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      list.scrollTop = list.scrollHeight;
      updateScrollButton();
    });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    return false;
  }
}

// 复制按钮的就地反馈（图标按钮换对勾 / 文字按钮换文案）实现放在 ui-bits.js
const flashCopyButton = (button, ok) => window.SXW_UI.flashCopy(button, ok);

// 消息时间：后端 add_time 是秒；新消息没有值就用当前时间
function formatClock(seconds) {
  const stamp = Number(seconds || 0);
  const date = stamp > 0 ? new Date(stamp * 1000) : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作条右侧的「模型 · 时间」：模型名取当前生效值，取不到就不硬编一个假名字
function modelLabel() {
  return state.model || state.defaultModel || '模型';
}

function messageRaw(row) {
  const bubble = row ? row.querySelector('.bubble') : null;
  return bubble ? String(bubble.dataset.raw || bubble.textContent || '') : '';
}

// 这条 AI 回复上方最近的一条用户消息 = 重新生成要重发的原文
function promptBefore(row) {
  let prev = row.previousElementSibling;
  while (prev) {
    if (prev.classList && prev.classList.contains('msg-row') && prev.classList.contains('is-user')) {
      return messageRaw(prev)
        .replace(/^\[上传文件\][^\n]*\n*/gm, '')
        .trim();
    }
    prev = prev.previousElementSibling;
  }
  return '';
}

async function regenerateFrom(row) {
  if (state.generating) {
    notifyBusy('重新生成');
    return;
  }
  // 这条回复后面还有消息：重生成会让后续轮次悬空，先问一次（效果图确认弹窗的用途之一）
  const later = row.nextElementSibling;
  if (later && later.classList && later.classList.contains('msg-row')) {
    openConfirm({
      title: '重新生成这一条？',
      text: '这一条之后还有对话内容，重新生成会丢掉它们，并以新的回答替换当前这条。',
      note: '丢弃的内容不可恢复。',
      okText: '重新生成',
      onConfirm: () => runAsync('重新生成', () => doRegenerate(row))
    });
    return;
  }
  await doRegenerate(row);
}

async function doRegenerate(row) {
  const prompt = promptBefore(row);
  if (!prompt) {
    notify('找不到对应的提问', '这条回复缺了原始提问，请重新输入一次', 'warn');
    return;
  }
  const parent = row.parentNode;
  const next = row.nextSibling;
  row.remove();
  refreshMsgActions();
  // 后端把旧回答降级为「上一版」并新增当前版；附件由后端从原消息回读（图片也能重新看图）
  const accepted = await sendMessage(prompt, {
    echo: false,
    attachments: [],
    regenerate: true,
    onDone: (handle) => attachRevertButton(handle)
  });
  // 请求根本没发出去（离线 / 超长 / 模型不支持附件）：把这条回答放回原位，
  // 否则界面上的回答凭空消失，用户会以为记录丢了
  if (accepted === false && parent) {
    parent.insertBefore(row, next);
    refreshMsgActions();
  }
}

// 重新生成后给这一条挂「回退上一版」：只在本条消息上有，用过即消失（刷新后不再出现）
function attachRevertButton(handle) {
  const actions = handle.row.querySelector('.msg-actions');
  if (!actions || !state.conversationId) {
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-action';
  button.textContent = '回退上一版';
  button.addEventListener('click', () => {
    runAsync('回退到上一版', async () => {
      const body = await requestJson(`/conversations/${state.conversationId}/revert`, { method: 'POST' });
      if (!body || typeof body.content !== 'string') {
        notify('没有可回退的版本', '这条回答只有当前这一版', 'warn');
        return;
      }
      handle.update(body.content, false);
      button.remove();
      notify('已回退到上一版', '当前显示的是重新生成前的内容', 'ok');
    });
  });
  // 插在「复制/朗读/重新生成」之后、右侧模型·时间之前，不破坏操作条的两端对齐
  const spacer = actions.querySelector('.msg-actions-spacer');
  if (spacer) {
    actions.insertBefore(button, spacer);
  } else {
    actions.appendChild(button);
  }
}

// 「重新生成」只对最后一条回复有意义：新消息进来自动前移
// 历史分帧渲染时每插一条都会调一次，用 rAF 合并，避免 O(n²) 的全量扫描
let refreshActionsFrame = 0;

function refreshMsgActions() {
  if (refreshActionsFrame) {
    return;
  }
  refreshActionsFrame = window.requestAnimationFrame(() => {
    refreshActionsFrame = 0;
    const rows = Array.from(dom['message-list'].querySelectorAll('.msg-row.is-ai'));
    rows.forEach((row, index) => {
      const regen = row.querySelector('.msg-action[data-action="regen"]');
      if (regen) {
        regen.hidden = index !== rows.length - 1;
      }
    });
  });
}

async function handleMessageAction(button) {
  const row = button.closest('.msg-row');
  const kind = button.dataset.action;
  if (kind === 'copy') {
    const ok = await copyText(messageRaw(row));
    flashCopyButton(button, ok);
    if (!ok) {
      notify('复制失败', '请手动选中文本后按 Ctrl+C', 'error');
    }
    return;
  }
  if (kind === 'speak') {
    toggleSpeak(row, button);
    return;
  }
  if (kind === 'regen') {
    await regenerateFrom(row);
  }
}

// ===== 朗读：系统 speechSynthesis，不引入额外依赖 =====
let speakingRow = null;

function stopSpeaking() {
  if (!('speechSynthesis' in window)) {
    return;
  }
  window.speechSynthesis.cancel();
  if (speakingRow) {
    const button = speakingRow.querySelector('.msg-action[data-action="speak"]');
    if (button) {
      button.classList.remove('is-on');
      button.title = '朗读';
      button.setAttribute('aria-label', '朗读');
    }
    speakingRow = null;
  }
}

function toggleSpeak(row, button) {
  if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
    notify('无法朗读', '当前系统没有可用的语音合成引擎', 'warn');
    return;
  }
  if (speakingRow === row) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  // Markdown 洗成纯文本再念：符号与表格念出来只有噪音；超长回复截断避免长时间占着语音引擎
  const text = messageRaw(row)
    .replace(/```[\s\S]*?```/g, '（代码块）')
    .replace(/[#>*`_|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (Array.from(text).length < SPEAK_MIN_CHARS) {
    notify('内容太短', `这段不足 ${SPEAK_MIN_CHARS} 字，不需要朗读`, 'info');
    return;
  }
  const utter = new SpeechSynthesisUtterance(text.slice(0, SPEAK_MAX_CHARS));
  utter.lang = 'zh-CN';
  utter.rate = 1;
  utter.onend = () => {
    if (speakingRow === row) {
      stopSpeaking();
    }
  };
  utter.onerror = utter.onend;
  speakingRow = row;
  button.classList.add('is-on');
  button.title = '停止朗读';
  button.setAttribute('aria-label', '停止朗读');
  window.speechSynthesis.speak(utter);
}

// 消息区事件委托：代码复制 / 代码折叠 / 消息复制与重新生成共用一次绑定（不再逐条绑监听器）
function bindMessageActions() {
  const list = dom['message-list'];
  list.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const codeCopy = target.closest('.code-copy');
    if (codeCopy) {
      const block = codeCopy.closest('.code-block');
      const code = block ? block.querySelector('code') : null;
      copyText(code ? code.textContent : '').then((ok) => {
        flashCopyButton(codeCopy, ok);
        if (!ok) {
          notify('复制失败', '请手动选中文本后按 Ctrl+C', 'error');
        }
      });
      return;
    }
    const toggle = target.closest('.code-toggle');
    if (toggle) {
      const block = toggle.closest('.code-block');
      if (!block) {
        return;
      }
      const collapsed = block.classList.toggle('is-collapsed');
      toggle.textContent = collapsed ? `展开 ${block.dataset.lines || ''} 行` : '收起';
      // 记住这次选择：流式后续帧整块重绘时不再折回去
      // 必须操作 lib 里那个 Set 的同一份引用：另建一个 Set 会让「展开」在下一次重渲染时被折回
      if (block.dataset.codeKey) {
        if (collapsed) {
          SXWMarkdown.expandedCode.delete(block.dataset.codeKey);
        } else {
          SXWMarkdown.expandedCode.add(block.dataset.codeKey);
        }
      }
      updateScrollButton(); // 展开 / 收起改变了内容高度，按钮状态要跟着重算
      return;
    }
    const action = target.closest('.msg-action');
    if (action) {
      runAsync('消息操作', () => handleMessageAction(action));
    }
  });
  list.addEventListener('scroll', updateScrollButton, { passive: true });
  dom['btn-scroll-bottom'].addEventListener('click', () => scrollToBottom(true));
}

// 附件类型标签：卡片图标、预览标题、下载提示共用一套（不靠浏览器嗅探 mime）
const ATTACH_LABELS = {
  'image/png': '图片',
  'image/jpeg': '图片',
  'image/gif': '图片',
  'image/webp': '图片',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12': 'Excel',
  'text/markdown': 'Markdown',
  'text/plain': '文本',
  'text/csv': 'CSV',
  'application/json': 'JSON'
};

function attachLabel(mime, name) {
  const key = String(mime || '').toLowerCase();
  if (ATTACH_LABELS[key]) {
    return ATTACH_LABELS[key];
  }
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return '图片';
  }
  if (ext === 'pdf') {
    return 'PDF';
  }
  if (ext === 'docx') {
    return 'Word';
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    return 'Excel';
  }
  return '文件';
}

// 文档卡片上的方形徽标文字（图片走缩略图，不用徽标）
function attachBadge(mime, name) {
  const label = attachLabel(mime, name);
  if (label === '图片') {
    return 'IMG';
  }
  if (label === 'Markdown') {
    return 'MD';
  }
  return label.toUpperCase().slice(0, 4);
}

// 历史消息里 `[上传文件] 文件名` 是落库文本的首行：显示时拆出来交给附件卡片，正文只留问题与抽取文本
function splitUploadContent(content) {
  const text = String(content || '');
  const match = /^\[上传文件\]\s*(.+?)\s*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { name: '', text };
  }
  return { name: match[1], text: text.slice(match[0].length).replace(/^\s*\n/, '') };
}

function buildAttachCard(attachment) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'attach-card';
  card.dataset.name = attachment.name || '附件';
  card.dataset.mime = attachment.mime || '';
  card.dataset.size = String(attachment.size || 0);
  card.dataset.kind = attachment.kind || 'text';
  card.dataset.truncated = attachment.truncated ? '1' : '0';
  if (attachment.id) {
    card.dataset.attachId = String(attachment.id);
  }
  if (attachment.localKey) {
    card.dataset.local = attachment.localKey;
  }
  const isImage = attachment.kind === 'image' || String(attachment.mime || '').startsWith('image/');
  if (isImage) {
    const thumb = document.createElement('img');
    thumb.className = 'attach-card-thumb';
    thumb.alt = attachment.name || '图片';
    card.appendChild(thumb);
  } else {
    const icon = document.createElement('span');
    icon.className = 'attach-card-icon';
    icon.textContent = attachBadge(attachment.mime, attachment.name);
    card.appendChild(icon);
  }
  const meta = document.createElement('span');
  meta.className = 'attach-card-meta';
  const name = document.createElement('span');
  name.className = 'attach-card-name';
  name.textContent = attachment.name || '附件';
  const sub = document.createElement('span');
  sub.className = 'attach-card-sub';
  sub.textContent = `${attachLabel(attachment.mime, attachment.name)} · ${formatFileSize(attachment.size)}`;
  meta.appendChild(name);
  meta.appendChild(sub);
  if (attachment.missing) {
    card.classList.add('is-missing');
    card.dataset.missing = '1';
  }
  const open = document.createElement('span');
  open.className = 'attach-card-open';
  open.textContent = attachment.missing ? '未保存' : isImage ? '放大' : '查看';
  card.appendChild(meta);
  card.appendChild(open);
  if (isImage) {
    fillThumbnail(card, attachment);
  }
  return card;
}

// 折叠按钮：只用于「用户消息里超长的附件抽取正文」，模型输出永不折叠
function buildFoldButton(bubble, totalChars) {
  const label = `展开全文（约 ${totalChars} 字）`;
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'msg-fold';
  fold.textContent = label;
  fold.addEventListener('click', () => {
    const folded = bubble.classList.toggle('is-folded');
    fold.textContent = folded ? label : '收起';
    updateScrollButton();
  });
  return fold;
}

// 用户气泡：正文 + 附件卡片；正文过长先折叠（文档抽取正文 + 问题会合成一条）
// target 只在「往前插入更早的历史」时传：{ container, before }，
// 不传就是常规追加（追加才自动滚到底，插历史时滚动位置由调用方锚定）
function appendUserMessage(text, attachment, rawText, addTime, target) {
  markEmptyHidden();
  const row = document.createElement('div');
  row.className = 'msg-row is-user';
  const stack = document.createElement('div');
  stack.className = 'msg-user-stack';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const attachList = Array.isArray(attachment) ? attachment.filter(Boolean) : attachment ? [attachment] : [];
  const attachLine = attachList.map((item) => `[上传文件] ${item.name}`).join('\n');
  bubble.dataset.raw = rawText || (attachLine && text ? `${attachLine}\n\n${text}` : attachLine || text);
  attachList.forEach((item) => bubble.appendChild(buildAttachCard(item)));
  if (text) {
    const body = document.createElement('span');
    body.className = 'msg-text';
    body.textContent = text;
    bubble.appendChild(body);
  }
  stack.appendChild(bubble);
  // 折叠按钮放在气泡外：折叠态气泡是 overflow:hidden，放里面会被裁掉
  const totalChars = Array.from(String(text || '')).length;
  if (totalChars > MAX_FOLD_CHARS) {
    bubble.classList.add('is-folded');
    stack.appendChild(buildFoldButton(bubble, totalChars));
  }
  // 气泡下方右对齐：复制 + 时间（效果图第 2 屏；不做「编辑」——后端没有改消息接口）
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML =
    `<button class="msg-action is-ico" type="button" data-action="copy" title="复制" aria-label="复制">${MSG_ICONS.copy}</button>` +
    `<time class="msg-time">${formatClock(addTime)}</time>`;
  stack.appendChild(actions);
  row.appendChild(stack);
  if (target && target.before) {
    target.container.insertBefore(row, target.before);
  } else {
    (target ? target.container : dom['message-list']).appendChild(row);
  }
  refreshMsgActions();
  if (!target) {
    scrollToBottom(true);
  }
  return row;
}

// 首字返回前的「思考中」占位：先只给三点，1.5s 后才开始计时并说明在做什么
const THINKING_DELAY_MS = 1500; // 小于这个时长不显示计时，避免一闪而过
const THINKING_STOP_HINT_MS = 15000; // 超过这个时长提示可以停止
const THINKING_TICK_MS = 500; // 计时刷新间隔

function thinkingText(elapsedMs, attachmentCount) {
  if (elapsedMs < THINKING_DELAY_MS) {
    return '思考中…';
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const stage = attachmentCount > 0 ? `正在解析 ${attachmentCount} 个附件` : '正在生成';
  const hint = elapsedMs >= THINKING_STOP_HINT_MS ? '，可点右侧停止' : '';
  return `${seconds}s ｜ ${stage}${hint}`;
}

function thinkingHtml(elapsedMs, attachmentCount) {
  const dots =
    '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
  return `<span class="thinking">${dots}<span class="thinking-text">${thinkingText(
    elapsedMs,
    attachmentCount
  )}</span></span>`;
}

const THINKING_HTML = thinkingHtml(0, 0);

// 创建一条 AI 气泡 + 消息操作条，返回可增量更新的句柄（流式渲染用）
function appendAiMessage(addTime, attachmentCount = 0, target, modelName) {
  markEmptyHidden();
  const row = document.createElement('div');
  row.className = 'msg-row is-ai';
  const stack = document.createElement('div');
  stack.className = 'msg-stack';
  const bubble = document.createElement('div');
  bubble.className = 'bubble markdown-body is-thinking';
  bubble.innerHTML = THINKING_HTML;
  // 操作条常显：复制 / 朗读 / 重新生成，右端「模型 · 时间」（效果图第 2 屏）
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML =
    `<button class="msg-action is-ico" type="button" data-action="copy" title="复制" aria-label="复制">${MSG_ICONS.copy}</button>` +
    `<button class="msg-action is-ico" type="button" data-action="speak" title="朗读" aria-label="朗读">${MSG_ICONS.speak}</button>` +
    `<button class="msg-action is-ico" type="button" data-action="regen" title="重新生成" aria-label="重新生成">${MSG_ICONS.regen}</button>` +
    '<span class="msg-actions-spacer"></span>' +
    `<span class="msg-meta-time">${modelName || modelLabel()} · ${formatClock(addTime)}</span>`;
  stack.appendChild(bubble);
  stack.appendChild(actions);
  row.appendChild(stack);
  if (target && target.before) {
    target.container.insertBefore(row, target.before);
  } else {
    (target ? target.container : dom['message-list']).appendChild(row);
  }
  refreshMsgActions();
  if (!target) {
    // 气泡插在用户消息之后，必须立刻滚到底，否则矮窗口下「思考中」只露出一条边
    scrollToBottom(true);
  }

  let frame = 0;
  let pending = null;
  let thinkingTimer = null;
  let thinkingStartedAt = 0;

  // 思考计时：让用户能区分「在跑」和「卡了」；首字到达即停，耗时留在操作条上
  const stopThinking = () => {
    if (!thinkingTimer) {
      return;
    }
    window.clearInterval(thinkingTimer);
    thinkingTimer = null;
    const elapsed = Date.now() - thinkingStartedAt;
    if (elapsed >= 1000) {
      const duration = document.createElement('span');
      duration.className = 'msg-duration';
      duration.textContent = `${Math.max(1, Math.round(elapsed / 1000))}s`;
      duration.title = '本次生成耗时';
      const meta = actions.querySelector('.msg-meta-time');
      if (meta) {
        meta.before(duration);
      } else {
        actions.prepend(duration);
      }
    }
  };

  const startThinking = () => {
    if (thinkingTimer) {
      return;
    }
    thinkingStartedAt = Date.now();
    const tick = () => {
      const elapsed = Date.now() - thinkingStartedAt;
      // 只改文案，不重建整个节点：三点跳动的动画不会每次重启
      const label = bubble.querySelector('.thinking-text');
      if (label) {
        label.textContent = thinkingText(elapsed, attachmentCount);
      } else {
        bubble.innerHTML = thinkingHtml(elapsed, attachmentCount);
      }
    };
    tick();
    thinkingTimer = window.setInterval(tick, THINKING_TICK_MS);
  };

  // 增量渲染：气泡内容拆成「已闭合块容器 + 末尾块容器」两层。
  // 前缀块的 DOM 节点插入后不再动，每帧只重渲染还在增长的末尾块：
  //   1. 每帧的解析量与 DOM 重建量都只跟「末尾那一小段」有关，而不是整条回答；
  //   2. 用户手动展开的代码块、选中的文字都在前缀节点里，不会被每帧的 innerHTML 冲掉。
  // 缓存放闭包里，气泡销毁即释放；文本变短（重新生成 / 停止回填）时前缀比对失配，
  // 从第一个不同的块起截断重加，不会残留上一条回复的内容。
  let answerNodes = null;

  const ensureAnswerNodes = () => {
    if (answerNodes && answerNodes.closedEl.isConnected) {
      return answerNodes;
    }
    bubble.innerHTML = '<div class="answer-closed"></div><div class="answer-tail"></div>';
    answerNodes = {
      closedEl: bubble.firstElementChild,
      tailEl: bubble.lastElementChild,
      texts: [], // 每块原文，用于判断能否复用
      nodeCounts: [] // 每块插入的顶层节点数，回退时按块从末尾删
    };
    return answerNodes;
  };

  const renderAnswer = (text, showCursor) => {
    const nodes = ensureAnswerNodes();
    const parts = SXWStreamBlocks.splitMarkdownBlocks(text);

    // 1. 前缀块：原文一致的块其 DOM 已就位，直接跳过
    let reuse = 0;
    while (reuse < parts.closed.length && reuse < nodes.texts.length && nodes.texts[reuse] === parts.closed[reuse]) {
      reuse += 1;
    }
    if (reuse < nodes.texts.length) {
      for (let index = nodes.texts.length - 1; index >= reuse; index -= 1) {
        for (let removed = 0; removed < nodes.nodeCounts[index]; removed += 1) {
          if (nodes.closedEl.lastElementChild) {
            nodes.closedEl.lastElementChild.remove();
          }
        }
      }
      nodes.texts.length = reuse;
      nodes.nodeCounts.length = reuse;
    }
    for (let index = reuse; index < parts.closed.length; index += 1) {
      const holder = document.createElement('div');
      holder.innerHTML = SXWMarkdown.renderMarkdown(parts.closed[index]);
      const count = holder.childNodes.length;
      // 用 fragment 搬运：节点本身被搬进页面后就不再替换，展开状态与选区都留得住
      const fragment = document.createDocumentFragment();
      while (holder.firstChild) {
        fragment.appendChild(holder.firstChild);
      }
      nodes.closedEl.appendChild(fragment);
      nodes.texts.push(parts.closed[index]);
      nodes.nodeCounts.push(count);
    }

    // 2. 末尾块：本来就每帧在变，整体替换即可；光标挂在它尾部
    nodes.tailEl.innerHTML =
      SXWMarkdown.renderMarkdown(parts.tail) + (showCursor ? '<span class="cursor"></span>' : '');
  };

  const paint = (nextText, showCursor) => {
    // 首字到达或收尾时都要停表；只有「首字未到且仍在生成」才继续保持思考态
    if (!showCursor || nextText) {
      stopThinking();
    }
    bubble.dataset.raw = nextText; // 导出 / 复制用原始文本（气泡里是渲染后的 HTML）
    if (!nextText) {
      // 首字未到：保持「思考中」占位；结束时（showCursor=false）清空占位交由外层收尾
      bubble.classList.toggle('is-thinking', Boolean(showCursor));
      bubble.innerHTML = showCursor ? THINKING_HTML : '';
      return;
    }
    bubble.classList.remove('is-thinking');
    renderAnswer(nextText, showCursor);
  };

  // 一帧只渲染一次：SSE 每秒可能上百个 chunk，逐块全量重排会让长回复明显掉帧
  const flush = () => {
    frame = 0;
    if (!pending) {
      return;
    }
    const task = pending;
    pending = null;
    paint(task.text, task.cursor);
    scrollToBottom(); // 用户正往上翻历史时不抢滚动
  };

  const handle = {
    row,
    bubble,
    text: '',
    startThinking,
    update(nextText, showCursor) {
      handle.text = nextText;
      if (showCursor === false || !nextText) {
        // 收尾 / 首字未到：立即同步渲染，避免停止后残留光标或留下空泡
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        pending = null;
        paint(nextText, showCursor);
        if (showCursor) {
          scrollToBottom(true);
        }
        return;
      }
      pending = { text: nextText, cursor: showCursor };
      if (!frame) {
        frame = window.requestAnimationFrame(flush);
      }
    },
    remove() {
      row.remove();
      refreshMsgActions();
    }
  };
  return handle;
}

function appendErrorBubble(reason, onRetry) {
  markEmptyHidden();
  const row = document.createElement('div');
  row.className = 'msg-row is-error';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = 'AI';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const text = document.createElement('p');
  text.className = 'error-text';
  text.textContent = reason;
  bubble.appendChild(text);

  if (typeof onRetry === 'function') {
    const button = document.createElement('button');
    button.className = 'btn-retry';
    button.type = 'button';
    button.textContent = '重试';
    button.addEventListener('click', () => {
      row.remove();
      onRetry();
    });
    bubble.appendChild(button);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  dom['message-list'].appendChild(row);
  refreshMsgActions();
  scrollToBottom(true);
  return row;
}

function appendNote(text) {
  const note = document.createElement('p');
  note.className = 'msg-note';
  note.textContent = text;
  dom['message-list'].appendChild(note);
  scrollToBottom(true);
  return note;
}

// ===== 7. 发送与流式对话（~） ====
function friendlyError(error) {
  if (error instanceof TypeError) {
    return '无法连接后端，请确认服务已启动，然后重试';
  }
  // 超时走 AbortController：浏览器原始文案是英文，不能直接塞进提示条
  if (error && error.name === 'AbortError') {
    return '请求超时，请确认后端在运行后重试';
  }
  return (error && error.message) || '请求失败，请稍后重试';
}

// SSE 解析与流读取已整体搬到 renderer/lib/sse.js（index.html 在本文件之前按 classic script 加载），
// 拆出去是为了能在 Node 里用 node --test 直接压「一帧跨两个 chunk」这类边界。
// 本文件统一通过 SXWSse.xxx 调用。


function setGenerating(generating) {
  state.generating = generating;
  const button = dom['btn-send'];
  // 图标始终是 SVG（效果图）：停止态由 .is-stop 的圆环 + 方块伪元素表达，不能再改 textContent，
  // 否则一次发送就把箭头图标永久换成了字符
  button.classList.toggle('is-stop', generating);
  button.title = generating ? '停止生成' : '发送';
  button.setAttribute('aria-label', generating ? '停止生成' : '发送');
  updateComposer();
}

function stopGenerating() {
  if (!state.generating || !state.controller) {
    return;
  }
  state.stoppedByUser = true;
  state.controller.abort();
}

async function sendMessage(rawText, options) {
  const opts = options || {};
  if (state.generating) {
    return false;
  }
  // 允许把模型删空，但空了就不能再发：Enter 也走这条路，所以拦在这里而不只靠按钮 disabled
  if (state.modelsChecked && state.models.length === 0) {
    notify('还没有可用的模型', '先去「设置 → 模型」添加一个再开始对话', 'warn');
    return false;
  }
  const message = String(rawText == null ? dom['input-message'].value : rawText).trim();
  // 附件与文字至少有一个即可发送（可以先选附件再发）
  // attachments 传了数组就用它（重试 / 重新生成场景），没传就用输入坞里待发的
  const attaches = Array.isArray(opts.attachments)
    ? opts.attachments
    : opts.attachments === undefined
      ? state.attachments
      : [];
  const hasAttachments = attaches.length > 0;
  if (!message && !hasAttachments) {
    return false;
  }
  if (Array.from(message).length > MAX_MESSAGE_LENGTH) {
    notify('超出字数上限', `最多 ${MAX_MESSAGE_LENGTH} 字，请精简后再发送`, 'warn');
    return false;
  }
  if (state.online === false) {
    notify('后端未启动', '先启动服务，再点左下角「离线」重新检测', 'error');
    return false;
  }
  if (hasAttachments && currentModelCapability().vision === false) {
    notify('当前模型不支持附件', '在输入坞底部切换一个支持图片输入的模型', 'warn');
    return false;
  }

  state.lastMessage = message;
  state.lastAttachments = hasAttachments ? attaches.slice() : [];
  if (opts.echo !== false) {
    appendUserMessage(
      message,
      hasAttachments ? attaches.map((item) => buildLocalAttachment(item, item.localKey)) : null
    );
  }
  dom['input-message'].value = '';
  if (hasAttachments && opts.attachments === undefined) {
    clearAttachments(); // 附件已随本条消息发出，清掉待发状态
  }
  updateComposer();

  const ai = appendAiMessage(null, hasAttachments ? attaches.length : 0);
  ai.startThinking();
  const controller = new AbortController();
  state.controller = controller;
  state.stoppedByUser = false; // 新一轮开始先归零，否则上一轮的「主动停止」会污染本轮文案
  const seq = (state.streamSeq += 1); // 本轮唯一编号：过期回调不许再改界面
  setGenerating(true);

  let receivedLength = 0;
  let streamError = '';

  try {
    let response;
    if (hasAttachments) {
      // 带附件走 multipart（多附件用 files 字段，字段名与后端 uploads 合并逻辑对应）
      const form = new FormData();
      attaches.forEach((attach) => {
        form.append('files', base64ToBlob(attach.base64, attach.mime), attach.name);
      });
      form.append('message', message);
      if (state.model) {
        form.append('model', state.model);
      }
      if (state.conversationId) {
        form.append('conversation_id', String(state.conversationId));
      }
      response = await fetch(apiUrl('/chat_upload'), {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        signal: controller.signal
      });
    } else {
      const payload = { message };
      if (state.model) {
        payload.model = state.model;
      }
      if (state.conversationId) {
        payload.conversation_id = state.conversationId;
      }
      if (opts.regenerate) {
        payload.regenerate = true; // 后端覆盖最后一条 assistant，不新增问答
      }
      response = await fetch(apiUrl('/chat'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    }
    if (!response.ok) {
      throw new Error(await readDetail(response));
    }

    await SXWSse.readSseStream(response, {
      onContent: (chunk) => {
        if (seq !== state.streamSeq) {
          return; // 上一轮的迟到分片：丢弃，别把新一轮的内容覆盖掉
        }
        receivedLength += chunk.length;
        ai.update(ai.text + chunk, true);
      },
      onConversation: (id) => {
        if (seq !== state.streamSeq) {
          return;
        }
        state.conversationId = id;
        // 新会话的 id 在首字之前就到了：立刻置顶并补标题，不必等整段回答结束
        if (!touchConversationOrder(id)) {
          loadConversations();
        }
      },
      onError: (reason) => {
        streamError = reason;
      }
    });

    ai.update(ai.text, false);
    if (streamError) {
      if (!ai.text) {
        ai.remove();
      }
      // 重试必须用「本轮」的正文与附件快照：读 state.lastMessage 时用户可能已经发过下一条，
      // 点旧气泡的重试会重发新消息的正文（原提问丢失、内容在库里重复）
      appendErrorBubble(streamError, () => sendMessage(message, { echo: false, attachments: attaches }));
    } else if (!ai.text && receivedLength === 0) {
      ai.remove();
      appendNote('模型没有返回内容，请重试');
    } else {
      setConnection(true);
      // 重新生成后要把「回退上一版」挂到这条消息上，由调用方决定挂什么
      if (typeof opts.onDone === 'function') {
        opts.onDone(ai);
      }
    }
  } catch (error) {
    ai.update(ai.text, false);
    if (error && error.name === 'AbortError') {
      // 一个字都没收到就断了：留着空气泡只会让界面多一块空白，跟错误分支一样直接摘掉
      if (!ai.text) {
        ai.remove();
      }
      // 同一个 AbortError 有两种来源：用户点停止，或后端进程被关掉导致连接中断。
      // 后者绝不能显示「已停止生成」——用户没点过，会以为是自己误触
      appendNote(state.stoppedByUser ? '已停止生成' : '回复中断，可点击重新生成');
    } else {
      if (!ai.text) {
        ai.remove();
      }
      appendErrorBubble(friendlyError(error), () =>
        sendMessage(message, { echo: false, attachments: attaches })
      );
      if (error instanceof TypeError) {
        setConnection(false);
      }
    }
  } finally {
    // 只由「当前这一轮」复位：上一轮迟到收尾不能把新一轮的发送键和状态清掉
    if (seq === state.streamSeq) {
      setGenerating(false);
      state.controller = null;
    }
  }
  // 新会话落位后刷新左侧列表（标题与置顶）。
  // 不能加 `state.conversationId` 作为条件：会话 id 是单独一帧发来的，用户在首帧前点停止，
  // 或连接在首帧前断开时，后端已经建好会话并落库，而侧栏永远不会出现它
  if (seq === state.streamSeq) {
    await loadConversations();
  }
  return true;
}

// ===== 8. 输入区交互：自适应高度 + 字数提示 + 空消息禁用发送 ====
// --- 草稿：按会话存，切走再切回不丢；只有本地 UI 状态，不进配置文件 ─--
function draftKey() {
  return `${DRAFT_PREFIX}${state.conversationId == null ? 'new' : state.conversationId}`;
}

function writeDraft() {
  try {
    const text = dom['input-message'].value;
    if (text.trim()) {
      localStorage.setItem(draftKey(), text.slice(0, MAX_MESSAGE_LENGTH * 2));
    } else {
      localStorage.removeItem(draftKey());
    }
  } catch (error) {
    // 存储不可用 / 写满：草稿丢了不影响正常聊天
  }
}

function saveDraftSoon() {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = null;
    writeDraft();
  }, DRAFT_SAVE_DELAY);
}

function flushDraft() {
  if (draftTimer) {
    window.clearTimeout(draftTimer);
    draftTimer = null;
  }
  writeDraft();
}

function applyDraft() {
  let text = '';
  try {
    text = localStorage.getItem(draftKey()) || '';
  } catch (error) {
    text = '';
  }
  dom['input-message'].value = text;
  updateComposer();
}

let composerFrame = 0;

function updateComposer() {
  const text = dom['input-message'].value;
  const length = Array.from(text).length;
  const overLimit = length > MAX_MESSAGE_LENGTH;

  dom.counter.textContent = `${length} / ${MAX_MESSAGE_LENGTH}`;
  dom.counter.classList.toggle('is-over', overLimit);
  // 一个模型都没有时发送键直接禁用：这条消息注定失败，不如让用户先看顶部横幅
  const noModel = state.modelsChecked && state.models.length === 0;
  // 换库 / 恢复期间后端在重启：这条消息发出去只会 502，先挡住并说明原因
  const backendBusy = state.toolBusy && !state.generating;
  dom['btn-send'].disabled = backendBusy ? true : state.generating ? false : length === 0 || overLimit || noModel;
  dom['btn-send'].title = backendBusy
    ? state.toolBusyText || '正在执行备份 / 恢复等操作，完成后再发送'
    : noModel && !state.generating
      ? '还没有可用的模型，先去添加一个'
      : state.generating
        ? '停止生成'
        : '发送';

  // 高度计算要先写 auto 再读 scrollHeight（强制同步布局）：合并到一帧一次，输入时不卡
  if (!composerFrame) {
    composerFrame = window.requestAnimationFrame(() => {
      composerFrame = 0;
      const el = dom['input-message'];
      el.style.height = 'auto';
      const nextHeight = Math.min(Math.max(el.scrollHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT);
      el.style.height = `${nextHeight}px`;
    });
  }
  saveDraftSoon();

  // 只在「刚超限」时提示一次：每个按键都弹会把真正的错误提示刷掉
  if (overLimit && !state.overLimitNotified) {
    state.overLimitNotified = true;
    notify('超出字数上限', `最多 ${MAX_MESSAGE_LENGTH} 字，请精简后再发送`, 'warn');
  } else if (!overLimit) {
    state.overLimitNotified = false;
  }
  return { length, overLimit };
}

function bindComposer() {
  dom['input-message'].addEventListener('input', () => updateComposer());
  dom['input-message'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (state.generating) {
        return;
      }
      runAsync('发送消息', () => sendMessage());
    }
  });
  dom['btn-send'].addEventListener('click', () => {
    if (state.generating) {
      runAsync('停止生成', () => stopGenerating());
      return;
    }
    runAsync('发送消息', () => sendMessage());
  });
  // 首页三张任务卡：点击只填入输入框并聚焦，不自动发送（自动发送会让人以为误触）
  document.querySelectorAll('.empty-card').forEach((card) => {
    card.addEventListener('click', () => {
      const fill = card.dataset.fill || card.querySelector('b')?.textContent || '';
      dom['input-message'].value = String(fill).trim();
      updateComposer();
      dom['input-message'].focus();
    });
  });
}

// ===== 9. 桌面增强入口（设置 / 对话历史 / 主题 / 附件 / 菜单快捷键） =====

// 侧栏宽度：拖拽边界（sash）与「收起/展开」共用同一套边界值
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_DEFAULT_WIDTH = 272;
const SIDEBAR_WIDTH_KEY = 'sxw.sidebarWidth';

/**
 * 夹到安全区间：正文至少留 660px。
 * 660 ≈ 最小窗口 940 − 断点侧栏 244 − 1px 分隔线 − 两侧留白 40。
 * 这条下限只用来防「侧栏拖到 360 把正文挤没」，不再把 244 的断点宽度夹成 220——
 * 窗口收到最小时侧栏保持原宽，排版不因缩放而变。
 */
function clampSidebarWidth(value) {
  const ceiling = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(window.innerWidth - 660)));
  return Math.min(ceiling, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/** 读当前生效宽度（可能来自媒体查询，也可能来自用户拖动后的内联变量） */
function currentSidebarWidth() {
  const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'));
  return Number.isFinite(raw) && raw > 0 ? raw : SIDEBAR_DEFAULT_WIDTH;
}

function applySidebarWidth(value, persist) {
  const width = clampSidebarWidth(value);
  document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  if (dom['sidebar-resizer']) {
    dom['sidebar-resizer'].setAttribute('aria-valuenow', String(width));
  }
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch (error) {
      // 存储不可用就只在本会话生效
    }
  }
  return width;
}

// 侧栏收起 / 展开：只改根节点上的 data-sidebar，动画与布局全部交给 CSS 变量。
// 收起键在侧栏头部、展开键在主区顶栏同一水平线，两键交叉淡入淡出，不再 hidden 瞬切。
function bindSidebarToggle() {
  const root = document.documentElement;
  const sidebar = document.querySelector('.sidebar');
  const apply = (collapsed) => {
    root.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    // 收起后侧栏内容不可见：从 Tab 顺序里摘掉，否则键盘能聚焦到看不见的会话
    if (sidebar) {
      sidebar.inert = collapsed;
    }
    dom['btn-sidebar-expand'].setAttribute('aria-hidden', String(!collapsed));
    dom['btn-sidebar-collapse'].setAttribute('aria-hidden', String(collapsed));
    // 淡出但仍在 DOM 里的那颗不许被 Tab 选中
    dom['btn-sidebar-expand'].tabIndex = collapsed ? 0 : -1;
    dom['btn-sidebar-collapse'].tabIndex = collapsed ? -1 : 0;
    // 收起时拖拽边界不可用，键盘也不该停在一条看不见的线上
    if (dom['sidebar-resizer']) {
      dom['sidebar-resizer'].tabIndex = collapsed ? -1 : 0;
    }
    try {
      localStorage.setItem('sxw.sidebar', collapsed ? 'collapsed' : 'expanded');
    } catch (error) {
      // 隐私模式 / 存储被禁：状态不持久化，不影响使用
    }
  };
  dom['btn-sidebar-collapse'].addEventListener('click', () => apply(true));
  dom['btn-sidebar-expand'].addEventListener('click', () => apply(false));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'b') {
      event.preventDefault();
      apply(root.dataset.sidebar !== 'collapsed');
    }
  });
  let saved = 'expanded';
  try {
    saved = localStorage.getItem('sxw.sidebar') || 'expanded';
  } catch (error) {
    saved = 'expanded';
  }
  apply(saved === 'collapsed');
}

// 侧栏拖拽改宽：pointer capture 保证鼠标移出边界也不丢事件；
// 双击复位；键盘 ←→ 微调、Shift 加速、Home/End 到两端（读屏与键盘用户也能改）
function bindSidebarResizer() {
  const handle = dom['sidebar-resizer'];
  if (!handle) {
    return;
  }
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const begin = (event) => {
    if (event.button !== 0 || document.documentElement.dataset.sidebar === 'collapsed') {
      return;
    }
    dragging = true;
    startX = event.clientX;
    startWidth = currentSidebarWidth();
    handle.classList.add('is-active');
    document.body.classList.add('is-resizing');
    handle.setPointerCapture(event.pointerId);
    // 这里不能 preventDefault：Chromium 会因此吞掉后续的兼容鼠标事件，
    // 双击（dblclick）就永远不触发了——之前的「双击没反应」就是它
  };
  const move = (event) => {
    if (!dragging) {
      return;
    }
    applySidebarWidth(startWidth + (event.clientX - startX), false);
  };
  const end = (event) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.classList.remove('is-active');
    document.body.classList.remove('is-resizing');
    if (handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    applySidebarWidth(currentSidebarWidth(), true);
  };

  handle.addEventListener('pointerdown', begin);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  /** 复位 = 删掉内联变量，让媒体查询重新接管，同时清掉存储；给一句提示，否则宽度本来就等于默认值时像是没反应 */
  const resetWidth = () => {
    document.documentElement.style.removeProperty('--sidebar-w');
    try {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch (error) {
      // 忽略：复位只影响本会话也已生效
    }
    const width = currentSidebarWidth();
    handle.setAttribute('aria-valuenow', String(width));
    if (dom['sidebar-resizer']) {
      dom['sidebar-resizer'].setAttribute('aria-valuetext', `已恢复默认宽度 ${width}px`);
    }
    notify('侧栏已恢复默认宽度', `当前 ${width}px，拖动边界可再调整`, 'ok');
  };
  handle.addEventListener('dblclick', resetWidth);
  // 侧栏右侧整片也能双击复位：只留 12px 命中区时，绝大多数人根本不知道该点哪
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.addEventListener('dblclick', (event) => {
      // 会话条目、按钮、输入框上的双击有它们自己的含义，不抢
      if (event.target.closest('button, input, a, .session-item, .user-card')) {
        return;
      }
      resetWidth();
    });
  }
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === 'ArrowLeft') {
      applySidebarWidth(currentSidebarWidth() - step, true);
    } else if (event.key === 'ArrowRight') {
      applySidebarWidth(currentSidebarWidth() + step, true);
    } else if (event.key === 'Home') {
      applySidebarWidth(SIDEBAR_MIN_WIDTH, true);
    } else if (event.key === 'End') {
      applySidebarWidth(SIDEBAR_MAX_WIDTH, true);
    } else {
      return;
    }
    event.preventDefault();
  });

  // 恢复上次宽度；窗口变窄时重新夹一次，避免侧栏吃掉正文
  let saved = NaN;
  try {
    saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch (error) {
    saved = NaN;
  }
  if (Number.isFinite(saved) && saved > 0) {
    applySidebarWidth(saved, false);
  }
  // resize 每次事件都会触发强制同步布局（读布局再写 CSS 变量）：
  // 拖拽窗口边缘时一秒几十次，合并到一帧只算一次
  let sidebarFrame = 0;
  window.addEventListener('resize', () => {
    if (sidebarFrame) {
      return;
    }
    sidebarFrame = window.requestAnimationFrame(() => {
      sidebarFrame = 0;
      if (document.documentElement.style.getPropertyValue('--sidebar-w')) {
        applySidebarWidth(currentSidebarWidth(), false);
      }
    });
  });
}

function bindEnhanceEntries() {
  // 1. 设置 / 模型：都是独立窗口，主窗口只负责打开（界面在 views/settings.js、views/model.js）。
  // 重复点「设置」时主进程把已开的那扇提到最前，不会开第二个。
  dom['btn-settings'].addEventListener('click', () => openAppWindow('settings', {}));
  dom['model-banner-open'].addEventListener('click', () => openAppWindow('model', {}));

  // 2. 对话历史窗口
  dom['btn-memory'].addEventListener('click', () => openMemoryWindow());

  // 3. 主题切换（点击工具坞「主题」）
  dom['btn-theme'].addEventListener('click', () => runAsync('切换主题', () => toggleTheme()));

  // 4. 附件：点按钮走主进程多选文件，拖拽 / 粘贴走页内读取
  dom['btn-attach'].addEventListener('click', () => runAsync('选择附件', () => pickAttachment()));
  bindDropZone();

  // 5. 原生菜单与快捷键动作（唯一源 = main.js 菜单）
  if (window.desktopBridge && typeof window.desktopBridge.onMenuAction === 'function') {
    window.desktopBridge.onMenuAction((action) => handleMenuAction(action));
  }

  // 6. 连接状态入口：底部「离线」胶囊 / 离线横幅按钮
  dom['conn-text'].addEventListener('click', () => runAsync('重新连接', () => retryConnection()));
  dom['btn-offline-retry'].addEventListener('click', () =>
    runAsync('重新连接', () => retryConnection())
  );
  // 键盘用户也必须能触发重试：conn-text 是 role=button 的 span，原生不支持 Enter / Space
  dom['conn-text'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      runAsync('重新连接', () => retryConnection());
    }
  });
}

function handleMenuAction(action) {
  state.menuActions.push(action);
  if (action === 'new-chat') {
    startNewChat();
    return;
  }
  if (action === 'toggle-theme') {
    runAsync('切换主题', () => toggleTheme());
    return;
  }
  if (action === 'open-settings') {
    openAppWindow('settings', {});
    return;
  }
  if (action === 'export-chat') {
    runAsync('导出对话', () => exportMarkdown());
  }
}

// --- 独立子窗口：打开 / 等结果 / 静默同步 ---
/**
 * 一次「打开窗口」= 一次可以等结果的请求。
 *
 * 为什么按窗口 id 认领结果：确认、重命名、模型这些窗口允许同时开多扇，
 * 只留一个模块级回调（旧实现）会让后一次打开顶掉前一次，用户点「确定」落到错误的闭包上。
 */
const windowRequests = new Map(); // 窗口 id -> 等待结果的 resolve（一问一答）
const windowListeners = new Map(); // 窗口 id -> 长监听（登录窗口会提交多次：密码错 → 改 → 再提交）

function openAppWindow(view, payload) {
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.openWindow !== 'function') {
    notify('窗口功能不可用', '请重启应用后再试', 'error');
    return Promise.resolve(null);
  }
  return Promise.resolve(bridge.openWindow(view, payload || {}))
    .then((result) => {
      if (!result || !result.ok) {
        showToast((result && result.error) || '请稍后重试', { title: '窗口打开失败', type: 'error' });
        return null;
      }
      return result;
    })
    .catch((error) => {
      showToast(friendlyError(error), 'error');
      return null;
    });
}

/** 打开窗口并等它回传一次结果；窗口被直接关掉时按 null 结束，不会留下悬空的 Promise。 */
function askAppWindow(view, payload) {
  return openAppWindow(view, payload).then((result) => {
    if (!result) {
      return null;
    }
    const id = result.id;
    return new Promise((resolve) => {
      const previous = windowRequests.get(id);
      if (previous) {
        // 单例窗口被重复打开：上一次请求已经不可能再被回答，先让它落地
        previous(null);
      }
      windowRequests.set(id, resolve);
    });
  });
}

/** 子窗口回传结果 / 关窗：把对应请求落地。 */
function settleWindowRequest(packet) {
  const id = packet && packet.windowId;
  if (!id) {
    return;
  }
  const data = (packet && packet.data) || null;
  const resolve = windowRequests.get(id);
  if (resolve) {
    windowRequests.delete(id);
    resolve(data);
    return;
  }
  // 登录窗口允许「密码错 → 改 → 再提交」：这类窗口不是一问一答，
  // 用长监听接住后续每一次提交，直到窗口关闭
  const listener = windowListeners.get(id);
  if (listener) {
    listener(data);
  }
}

/** 给一扇窗挂多次结果监听（目前只有登录窗口需要）。 */
function listenWindowResults(windowId, handler) {
  if (!windowId) {
    return;
  }
  windowListeners.set(windowId, handler);
}

function openMemoryWindow() {
  if (!state.conversationId) {
    notify('还没有打开对话', '先在左侧点一个会话，再查看对话历史', 'info');
    return;
  }
  openAppWindow('memory', memoryPayload());
}

function memoryPayload() {
  return {
    conversationId: state.conversationId,
    title: dom['chat-title'] ? dom['chat-title'].textContent : ''
  };
}

/** 切会话后把新会话推给已开的历史窗口：内容与标题跟着换，不抢焦点。 */
let lastMemorySync = '';
function syncMemoryWindow() {
  if (!state.conversationId) {
    return;
  }
  const payload = memoryPayload();
  const stamp = `${payload.conversationId}|${payload.title}`;
  if (stamp === lastMemorySync) {
    return;
  }
  lastMemorySync = stamp;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.pushWindow !== 'function') {
    return;
  }
  Promise.resolve(bridge.pushWindow('memory', payload)).catch(() => {});
}

// --- 附件 ---
function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

function base64ToBlob(base64, mime) {
  const binary = window.atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

// 待发附件（数组）：每个都能单独查看 / 移除，发送时一起带上
function renderAttachments() {
  const bar = dom['attach-bar'];
  if (!bar) {
    return;
  }
  bar.innerHTML = '';
  const list = state.attachments;
  bar.hidden = list.length === 0;
  list.forEach((attach, index) => {
    const item = document.createElement('span');
    item.className = 'attach-item';
    item.dataset.index = String(index);
    if (attach.isImage && attach.base64) {
      const thumb = document.createElement('img');
      thumb.className = 'attach-thumb';
      thumb.alt = attach.name;
      thumb.src = `data:${attach.mime};base64,${attach.base64}`;
      item.appendChild(thumb);
    } else {
      const badge = document.createElement('span');
      badge.className = 'attach-thumb attach-thumb-badge';
      badge.textContent = attachBadge(attach.mime, attach.name);
      item.appendChild(badge);
    }
    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = attach.name;
    name.title = attach.name;
    const size = document.createElement('span');
    size.className = 'attach-size';
    size.textContent = formatFileSize(attach.size);
    meta.appendChild(name);
    meta.appendChild(size);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'attach-mini';
    open.textContent = '查看';
    open.addEventListener('click', () => {
      runAsync('打开附件', () => openAttachment(buildLocalAttachment(attach, attach.localKey)));
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attach-remove';
    remove.title = '移除这个附件';
    remove.textContent = '×';
    remove.addEventListener('click', () => removeAttachment(index));
    item.appendChild(meta);
    item.appendChild(open);
    item.appendChild(remove);
    bar.appendChild(item);
  });
  updateComposer();
}

function toAttachment(file) {
  const mime = file.mime || file.type || 'application/octet-stream';
  return {
    name: file.name || '未命名文件',
    size: Number(file.size) || 0,
    mime,
    base64: file.base64 || '',
    isImage: String(mime).startsWith('image/')
  };
}

// 追加多个附件：数量、单文件、合计体积、重复都在这儿拦（与后端上限同源）
function addAttachments(files) {
  const incoming = (Array.isArray(files) ? files : [files]).filter(Boolean);
  let added = 0;
  incoming.forEach((file) => {
    const attach = toAttachment(file);
    if (!attach.name || !attach.base64) {
      return;
    }
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      notify('附件数量超限', `一次最多 ${MAX_ATTACHMENTS} 个，多余的已跳过`, 'warn');
      return;
    }
    if (attach.size > MAX_LOCAL_BYTES) {
      notify('附件过大已跳过', `${attach.name} 超过 ${MAX_LOCAL_BYTES / (1024 * 1024)} MB`, 'warn');
      return;
    }
    const total = state.attachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    if (total + attach.size > MAX_TOTAL_LOCAL_BYTES) {
      notify(
        '附件总量超限',
        `合计不能超过 ${MAX_TOTAL_LOCAL_BYTES / (1024 * 1024)} MB，已跳过 ${attach.name}`,
        'warn'
      );
      return;
    }
    // 去重必须比内容：只比「名字 + 字节数」会把同一秒粘贴的两张截图（自动名带同一时间戳、
    // 体积恰好相同）当成同一份，第二张被静默丢掉，用户以为发了两张
    const duplicate = state.attachments.some(
      (item) =>
        item.name === attach.name && item.size === attach.size && item.base64 === attach.base64
    );
    if (duplicate) {
      notify('已跳过重复附件', `${attach.name} 与已添加的附件内容相同`, 'warn');
      return;
    }
    attach.localKey = `local-${++localAttachmentSeq}`;
    state.attachments.push(attach);
    added += 1;
  });
  renderAttachments();
  if (added && dom['input-message']) {
    dom['input-message'].focus();
  }
}

function removeAttachment(index) {
  state.attachments.splice(index, 1);
  renderAttachments();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

async function pickAttachment() {
  if (!window.desktopBridge || typeof window.desktopBridge.pickAttachment !== 'function') {
    notify('当前环境不支持选择文件', '请用「npm start」方式运行桌面端', 'warn');
    return;
  }
  const result = await window.desktopBridge.pickAttachment();
  if (!result || result.canceled) {
    return;
  }
  if (result.error) {
    showToast(result.error);
    return;
  }
  addAttachments(Array.isArray(result.files) ? result.files : [result]);
}

// 本地读文件（拖拽 / 粘贴共用）：先按上限拦一次，格式是否支持仍交后端判定（唯一清单）
// 支持一次读多个：全部读完再一次性入列表，避免「读一个补一个」把选择顺序打乱
function readLocalFiles(files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) {
    return;
  }
  Promise.all(list.map((file) => readOneFile(file)))
    .then((results) => addAttachments(results.filter(Boolean)))
    .catch(() => notify('文件读取失败', '这个文件可能被占用，重新选择一个试试', 'error'));
}

function readOneFile(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve(null);
      return;
    }
    if (Number(file.size) > MAX_LOCAL_BYTES) {
      notify('文件过大已跳过', `${file.name || '文件'} 超过 ${MAX_LOCAL_BYTES / (1024 * 1024)} MB`, 'warn');
      resolve(null);
      return;
    }
    const isImage = String(file.type || '').startsWith('image/');
    const stamp = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const autoName = `粘贴的图片-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
      stamp.getHours()
    )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
    const name =
      file.name && file.name !== 'image.png' ? file.name : isImage ? autoName : file.name || '未命名文件';
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      resolve({
        name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        base64: commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : ''
      });
    };
    reader.onerror = () => {
      notify('文件读取失败', '这个文件可能被占用，重新选择一个试试', 'error');
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

// 拖拽上传 + 粘贴截图：两条入口共用 readLocalFiles，附件一律先落到待发送状态
function bindDropZone() {
  const area = document.querySelector('.main-area') || document.body;
  area.addEventListener('dragenter', (event) => {
    event.preventDefault();
    area.classList.add('is-dragging');
  });
  area.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  area.addEventListener('dragleave', (event) => {
    if (event.target === area) {
      area.classList.remove('is-dragging');
    }
  });
  area.addEventListener('drop', (event) => {
    event.preventDefault();
    area.classList.remove('is-dragging');
    const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    readLocalFiles(files);
  });
  // 粘贴截图：Ctrl+V 把剪贴板里的图片变成待发送附件（可多张，截图提问是最常见的用法）
  dom['input-message'].addEventListener('paste', (event) => {
    const items =
      event.clipboardData && event.clipboardData.items ? Array.from(event.clipboardData.items) : [];
    const files = items
      .filter((item) => item.type && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    readLocalFiles(files);
  });
}

// --- 附件查看：图片灯箱 / 文档正文预览 / 另存与系统打开 ---
const attachmentBlobCache = new Map(); // 附件 id → blob URL（消息卡片缩略图用，避免重复下载）
const localAttachments = new Map(); // localKey → {name,mime,size,base64,kind}（刚发出、后端还没给 id）
let localAttachmentSeq = 0;

function attachKindOf(mime) {
  return String(mime || '').startsWith('image/') ? 'image' : 'text';
}

// 切会话 / 清屏时释放图片 blob URL：不释放会在长会话里累积上百个对象 URL
function releaseAttachmentBlobs() {
  attachmentBlobCache.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      // 已释放的 URL 再 revoke 不影响功能
    }
  });
  attachmentBlobCache.clear();
}

// 本地刚选的附件：base64 先存内存，卡片才能立刻出缩略图并点开放大（后端此时还没有 id）
function buildLocalAttachment(attach, reuseKey) {
  if (!attach) {
    return null;
  }
  const kind = attach.isImage || attachKindOf(attach.mime) === 'image' ? 'image' : 'text';
  const localKey = reuseKey || `local-${++localAttachmentSeq}`;
  localAttachments.set(localKey, {
    name: attach.name,
    mime: attach.mime,
    size: attach.size,
    base64: attach.base64,
    kind
  });
  return { name: attach.name, mime: attach.mime, size: attach.size, kind, localKey };
}

async function fetchAttachmentBlob(id) {
  const response = await fetchWithTimeout(
    apiUrl(`/attachments/${id}`),
    { headers: authHeaders() },
    MEMORY_TIMEOUT
  );
  if (!response.ok) {
    throw new Error(await readDetail(response));
  }
  return response.blob();
}

async function attachmentObjectUrl(attachment) {
  if (attachment.localKey) {
    const local = localAttachments.get(attachment.localKey);
    if (local && local.base64) {
      return `data:${local.mime};base64,${local.base64}`;
    }
    throw new Error('这个附件的本地数据已释放，请重新上传');
  }
  if (!attachment.id) {
    throw new Error('这个附件是旧版本上传的，本机没有保存原文件');
  }
  if (attachmentBlobCache.has(attachment.id)) {
    return attachmentBlobCache.get(attachment.id);
  }
  const url = URL.createObjectURL(await fetchAttachmentBlob(attachment.id));
  attachmentBlobCache.set(attachment.id, url);
  return url;
}

// 缩略图异步补：历史图片要带鉴权头取 blob，不能直接把接口地址塞进 <img src>
async function fillThumbnail(card, attachment) {
  const thumb = card.querySelector('.attach-card-thumb');
  if (!thumb) {
    return;
  }
  try {
    thumb.src = await attachmentObjectUrl(attachment);
  } catch (error) {
    const icon = document.createElement('span');
    icon.className = 'attach-card-icon';
    icon.textContent = attachBadge(attachment.mime, attachment.name);
    thumb.replaceWith(icon);
  }
}

// --- 附件查看：图片进灯箱窗口，文档进预览窗口（正文请求与缩放都在窗口自己那边） ---
/**
 * 交给子窗口的载荷。
 * base64 只对「刚选还没发送」的本地附件有意义：那是主窗口内存里的数据，子窗口拿不到；
 * 历史附件只给 id，窗口自己带鉴权去后端取，避免把整份文件塞进 IPC。
 */
function attachmentPayload(attachment) {
  const payload = {
    id: attachment.id || 0,
    localKey: attachment.localKey || '',
    name: attachment.name || '附件',
    mime: attachment.mime || '',
    size: Number(attachment.size) || 0,
    kind: attachment.kind || attachKindOf(attachment.mime)
  };
  if (attachment.localKey) {
    const local = localAttachments.get(attachment.localKey);
    if (local && local.base64) {
      payload.base64 = local.base64;
    }
  }
  return payload;
}

function openAttachment(attachment) {
  if (!attachment) {
    return Promise.resolve(null);
  }
  const image = attachment.kind === 'image' || attachKindOf(attachment.mime) === 'image';
  return openAppWindow(image ? 'lightbox' : 'preview', { attachment: attachmentPayload(attachment) });
}

function attachmentFromCard(card) {
  return {
    id: card.dataset.attachId ? Number(card.dataset.attachId) : 0,
    localKey: card.dataset.local || '',
    name: card.dataset.name || '附件',
    mime: card.dataset.mime || '',
    size: Number(card.dataset.size || 0),
    kind: card.dataset.kind || 'text',
    truncated: card.dataset.truncated === '1'
  };
}

// 用系统程序打开 / 另存：渲染进程只交 base64 与文件名，落盘与调用都在主进程
function bindAttachmentViewer() {
  // 消息里的附件卡片：图片进灯箱窗口，文档进正文预览窗口。
  // 多开是有意的——同时对照两份文档是真实需求，第二份不会顶掉第一份。
  dom['message-list'].addEventListener('click', (event) => {
    const card = event.target && event.target.closest ? event.target.closest('.attach-card') : null;
    if (!card) {
      return;
    }
    if (card.dataset.missing === '1') {
      notify('这条附件无法预览', '它来自旧版本，原文件当时没有保存', 'warn');
      return;
    }
    runAsync('打开附件', () => openAttachment(attachmentFromCard(card)));
  });
}

// --- 导出 Markdown（「导出当前对话」；内容取气泡里保存的原始文本） ---
function currentConversationTitle() {
  const item = state.conversations.find((row) => row.id === state.conversationId);
  return (item && item.title) || '新的对话';
}

function exportFileName() {
  // 用本地日期：toISOString 是 UTC，东八区凌晨导出会少一天
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const safe = currentConversationTitle().replace(/[\\/:*?"<>|]/g, '_').slice(0, 30) || '对话';
  return `${safe}-${stamp}.md`;
}

function buildMarkdownExport() {
  const lines = [`# ${currentConversationTitle()}`, ''];
  dom['message-list'].querySelectorAll('.msg-row.is-user, .msg-row.is-ai').forEach((row) => {
    const bubble = row.querySelector('.bubble');
    if (!bubble) {
      return;
    }
    const text = String(bubble.dataset.raw || bubble.textContent || '').trim();
    if (!text) {
      return;
    }
    lines.push(row.classList.contains('is-user') ? '## 我' : '## AI', '', text, '');
  });
  return `${lines.join('\n').trim()}\n`;
}

async function exportMarkdown() {
  if (state.generating) {
    notify('暂时不能导出', '正在生成回复，等它结束再导出', 'warn');
    return;
  }
  if (!state.conversationId) {
    notify('还没有可导出的对话', '先聊一句，再导出为 Markdown', 'info');
    return;
  }
  if (!window.desktopBridge || typeof window.desktopBridge.saveMarkdown !== 'function') {
    notify('当前环境不支持导出', '请用「npm start」方式运行桌面端', 'warn');
    return;
  }
  const content = buildMarkdownExport();
  if (!content.trim()) {
    notify('没有可导出的内容', '这个会话里还没有消息', 'info');
    return;
  }
  // 导出数据源是已渲染的 DOM，不是后端：没点过「加载更早」的部分会被静默丢掉。
  // 与其让用户以为导全了，不如明确告知（导出继续，不拦操作）
  if (state.messagesHasMore) {
    notify('仅导出已加载的消息', '这个会话还有更早的记录，先点「加载更早的消息」再导出才完整', 'warn');
  }
  const result = await window.desktopBridge.saveMarkdown({ defaultName: exportFileName(), content });
  if (!result || result.canceled) {
    return;
  }
  if (result.error) {
    showToast(result.error);
    return;
  }
  notify('已导出', result.name, 'ok');
}

// ===== 9b. 会话内搜索（Ctrl+F）：Highlight API 上色，不改 DOM 也不重建 Markdown =====
const chatSearch = { ranges: [], index: -1 };

function supportsHighlight() {
  return Boolean(window.CSS && CSS.highlights && typeof window.Highlight === 'function');
}

function clearChatSearch() {
  if (supportsHighlight()) {
    CSS.highlights.delete('chat-search-hit');
  }
  chatSearch.ranges = [];
  chatSearch.index = -1;
  if (dom['chat-search-count']) {
    dom['chat-search-count'].textContent = '0 处';
  }
}

function runChatSearch(keyword) {
  const key = String(keyword || '').trim().toLowerCase();
  clearChatSearch();
  if (!key || !supportsHighlight()) {
    return;
  }
  const ranges = [];
  dom['message-list'].querySelectorAll('.bubble').forEach((bubble) => {
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = String(node.textContent || '').toLowerCase();
      let hit = text.indexOf(key);
      while (hit >= 0) {
        const range = new Range();
        range.setStart(node, hit);
        range.setEnd(node, hit + key.length);
        ranges.push(range);
        hit = text.indexOf(key, hit + key.length);
      }
      node = walker.nextNode();
    }
  });
  chatSearch.ranges = ranges;
  if (ranges.length) {
    CSS.highlights.set('chat-search-hit', new Highlight(...ranges));
  }
  dom['chat-search-count'].textContent = ranges.length ? `1 / ${ranges.length}` : '没找到';
  if (ranges.length) {
    chatSearch.index = 0;
    scrollSearchHitIntoView(ranges[0]);
  }
}

function scrollSearchHitIntoView(range) {
  const list = dom['message-list'];
  const rect = range.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  list.scrollTop += rect.top - listRect.top - listRect.height / 2 + rect.height / 2;
}

function gotoChatSearchHit(step) {
  if (!chatSearch.ranges.length) {
    return;
  }
  const total = chatSearch.ranges.length;
  chatSearch.index = (chatSearch.index + step + total) % total;
  scrollSearchHitIntoView(chatSearch.ranges[chatSearch.index]);
  dom['chat-search-count'].textContent = `${chatSearch.index + 1} / ${total}`;
}

function openChatSearch() {
  dom['chat-search'].hidden = false;
  dom['chat-search-input'].focus();
  dom['chat-search-input'].select();
  runChatSearch(dom['chat-search-input'].value);
}

function closeChatSearch() {
  dom['chat-search'].hidden = true;
  window.clearTimeout(chatSearchTimer);
  chatSearchTimer = 0;
  clearChatSearch();
}

// 会话内搜索每次按键都要遍历全部气泡并新建上千个 Range：不防抖的话长会话输入明显卡顿
let chatSearchTimer = 0;

function bindChatSearch() {
  dom['chat-search-input'].addEventListener('input', () => {
    window.clearTimeout(chatSearchTimer);
    chatSearchTimer = window.setTimeout(() => {
      chatSearchTimer = 0;
      runChatSearch(dom['chat-search-input'].value);
    }, SEARCH_DEBOUNCE_MS);
  });
  dom['chat-search-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      gotoChatSearchHit(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeChatSearch();
    }
  });
  dom['chat-search-prev'].addEventListener('click', () => gotoChatSearchHit(-1));
  dom['chat-search-next'].addEventListener('click', () => gotoChatSearchHit(1));
  dom['chat-search-close'].addEventListener('click', closeChatSearch);
  if (dom['btn-chat-search']) {
    dom['btn-chat-search'].addEventListener('click', () => openChatSearch());
  }
  // Ctrl+F / Cmd+F：capture 阶段拦下来，避免触发浏览器自带的查找栏
  document.addEventListener(
    'keydown',
    (event) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'f') {
        event.preventDefault();
        openChatSearch();
      }
    },
    true
  );
}

// 顶栏「更多」：只放次要动作（复制整段对话 / 对话历史 / 设置），主流程仍走常驻按钮
function bindMoreMenu() {
  const button = dom['btn-more'];
  const menu = dom['more-menu'];
  if (!button || !menu) {
    return;
  }
  const setOpen = (open) => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.more-wrap')) {
      setOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-more]');
    if (!item) {
      return;
    }
    setOpen(false);
    const action = item.dataset.more;
    if (action === 'memory') {
      openMemoryWindow();
    } else if (action === 'settings') {
      openAppWindow('settings', {});
    } else if (action === 'copy-all') {
      copyWholeConversation();
    } else if (action === 'export-md') {
      runAsync('导出对话', () => exportMarkdown());
    } else if (action.startsWith('window:')) {
      // 注册表驱动的窗口入口（WINDOW_DEFS 里标 menu:true 的窗口）
      openAppWindow(action.slice('window:'.length), {});
    }
  });

  // 窗口入口由注册表生成：新增窗口只要在 WINDOW_DEFS 里加一条并标 menu:true，
  // 这里会自动多出一项，主窗口代码不用改
  const bridge = window.desktopBridge;
  if (bridge && typeof bridge.windowEntries === 'function') {
    Promise.resolve(bridge.windowEntries())
      .then((entries) => {
        if (!Array.isArray(entries) || !entries.length) {
          return;
        }
        const sep = document.createElement('div');
        sep.className = 'more-sep';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        entries.forEach((entry) => {
          const item = document.createElement('button');
          item.className = 'more-item';
          item.type = 'button';
          item.setAttribute('role', 'menuitem');
          item.dataset.more = `window:${entry.view}`;
          item.textContent = entry.title;
          menu.appendChild(item);
        });
      })
      .catch(() => {});
  }
}

async function copyWholeConversation() {
  const rows = Array.from(dom['message-list'].querySelectorAll('.msg-row'));
  if (!rows.length) {
    notify('当前对话还没有内容', '先发一条消息，再复制整段对话', 'info');
    return;
  }
  const text = rows
    .map((row) => `${row.classList.contains('is-user') ? '我' : '随心问答'}：\n${messageRaw(row)}`)
    .join('\n\n');
  const ok = await copyText(text);
  if (ok) {
    notify('已复制整段对话', '已按「我 / 随心问答」分好段落，可直接粘贴', 'ok');
  } else {
    notify('复制失败', '请手动选中文本后按 Ctrl+C', 'error');
  }
}

// ===== 10. 通知：右上堆叠卡片（#toast 只做语义镜像） =====
/**
 * 通知统一口径（见 docs/页面设计规范.md 的 P4 设置）：第一行标题说「发生了什么」，第二行描述说「原因 / 下一步」。
 * 只有一句话的旧调用仍走 showToast 的单行分支——后端原文透传的错误不做二次改写。
 */
function notify(title, desc, type) {
  showToast(desc, { title, type: type || 'info' });
}

/** 「生成中」拦截共 6 处：标题固定，只换被拦下的动作，措辞不会再各写一套 */
function notifyBusy(action) {
  notify('正在生成回复', `等它写完或点「停止」后再${action}`, 'warn');
}

function showToast(text, options) {
  const message = String(text == null ? '' : text).trim();
  if (!message || !dom.toast) {
    return;
  }
  const opts = typeof options === 'string' ? { kind: options } : options || {};
  // 兼容两种写法：旧调用传 kind，效果图/新调用传 type:'ok'|'err'|'warn'|'info'
  const kindAlias = { ok: 'success', success: 'success', err: 'error', error: 'error', warn: 'warn', warning: 'warn', info: 'info' };
  const kind = kindAlias[opts.kind || opts.type] || 'info';

  // 语义镜像：#toast 只给读屏与冒烟断言用，标题与描述一起写进去
  dom.toast.textContent = opts.title ? `${opts.title} ${message}` : message;
  dom.toast.dataset.kind = kind;
  dom.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, TOAST_DURATION_MS);

  const stack = dom['toast-stack'];
  if (!stack) {
    return;
  }
  // 整摞的位置由 CSS 的 :has 跟随横幅，这里不再量一次（量完横幅再出现就会错位）

  const card = document.createElement('div');
  card.className = 'toast-card is-' + kind;
  card.setAttribute('role', 'status');
  const ico = document.createElement('span');
  ico.className = 'toast-ico';
  ico.innerHTML = (window.SXW_UI && window.SXW_UI.TOAST_ICONS[kind]) || '';
  const body = document.createElement('div');
  body.className = 'toast-body';
  if (opts.title) {
    const title = document.createElement('b');
    title.textContent = opts.title;
    body.appendChild(title);
  } else {
    body.classList.add('is-single');
  }
  const desc = document.createElement('span');
  desc.className = 'toast-desc';
  desc.textContent = message;
  body.appendChild(desc);
  card.appendChild(ico);
  card.appendChild(body);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-x';
  close.setAttribute('aria-label', '关闭通知');
  close.textContent = '\u00d7';
  card.appendChild(close);

  stack.appendChild(card);
  let closed = false;
  const dismiss = () => {
    if (closed) {
      return;
    }
    closed = true;
    card.classList.add('is-out');
    window.setTimeout(() => card.remove(), 220);
  };
  close.addEventListener('click', dismiss);

  const auto = kind === 'error' ? 0 : opts.duration || TOAST_DURATION_MS;
  if (auto) {
    const bar = document.createElement('span');
    bar.className = 'toast-bar';
    bar.style.animationDuration = auto + 'ms';
    card.appendChild(bar);
    window.setTimeout(dismiss, auto);
  }
  while (stack.children.length > 3) {
    stack.firstElementChild.remove();
  }
}

// ===== 11. 会话列表与搜索（会话条目 / 加载状态） ====
function setEmptyStateVisible(visible) {
  state.emptyHidden = !visible;
  if (dom['empty-state']) {
    dom['empty-state'].hidden = !visible;
  }
}

// 搜索：前端按标题过滤（交互规范；后端列表接口不带搜索参数）
function filteredConversations() {
  const keyword = state.searchKeyword.trim().toLowerCase();
  if (!keyword) {
    return state.conversations;
  }
  return state.conversations.filter((item) => String(item.title || '').toLowerCase().includes(keyword));
}

// 搜索命中高亮：关键词部分包 <mark>，其余保持纯文本（全部走 textContent，不拼 HTML）
function highlightText(text, keyword) {
  const fragment = document.createDocumentFragment();
  const source = String(text || '');
  const key = String(keyword || '').trim().toLowerCase();
  if (!key) {
    fragment.appendChild(document.createTextNode(source));
    return fragment;
  }
  const lower = source.toLowerCase();
  let from = 0;
  let hit = lower.indexOf(key);
  if (hit < 0) {
    fragment.appendChild(document.createTextNode(source));
    return fragment;
  }
  while (hit >= 0) {
    if (hit > from) {
      fragment.appendChild(document.createTextNode(source.slice(from, hit)));
    }
    const mark = document.createElement('mark');
    mark.textContent = source.slice(hit, hit + key.length);
    fragment.appendChild(mark);
    from = hit + key.length;
    hit = lower.indexOf(key, from);
  }
  if (from < source.length) {
    fragment.appendChild(document.createTextNode(source.slice(from)));
  }
  return fragment;
}

function buildSessionItem(item) {
  const row = document.createElement('div');
  const active = item.id === state.conversationId;
  row.className = `session-item${active ? ' is-active' : ''}`;
  // 会话条目本身可聚焦：键盘 Tab 到条目后 Enter / Space 即可打开
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-current', active ? 'true' : 'false');
  const title = document.createElement('span');
  title.className = 'session-title';
  title.title = item.title || '新的对话';
  title.appendChild(highlightText(item.title || '新的对话', state.searchKeyword));
  row.appendChild(title);
  row.addEventListener('click', () => switchConversation(item.id));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      switchConversation(item.id);
      return;
    }
    // 键盘用户右键菜单：Shift + F10，与 Windows 惯例一致
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openSessionMenu({ clientX: rect.left + 8, clientY: rect.bottom - 4 }, item);
    }
  });
  // 删除入口改右键菜单（悬停 × 已废弃）
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openSessionMenu(event, item);
  });
  return row;
}

// 会话右键菜单（描边风卡片，跟随光标；点外部 / Esc / 滚动关闭）
function openSessionMenu(event, item) {
  const menu = dom['session-menu'];
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  dom['session-menu-rename'].onclick = () => {
    closeSessionMenu();
    askRenameConversation(item);
  };
  dom['session-menu-delete'].onclick = () => {
    closeSessionMenu();
    askDeleteConversation(item);
  };
}

// --- 重命名会话：独立窗口（PATCH 在 views/rename.js 里完成，主窗口只同步列表与标题） ---
function askRenameConversation(item) {
  if (!item) {
    return;
  }
  askAppWindow('rename', { id: item.id, title: item.title || '' }).then((result) => {
    if (!result || result.action !== 'renamed') {
      return;
    }
    const next = result.title || '';
    state.conversations = state.conversations.map((row) =>
      row.id === result.id ? Object.assign({}, row, { title: next }) : row
    );
    renderSessionList();
    syncChatTitle();
  });
}

function closeSessionMenu() {
  dom['session-menu'].hidden = true;
}

function bindSessionMenu() {
  document.addEventListener('click', (event) => {
    if (!dom['session-menu'].hidden && !dom['session-menu'].contains(event.target)) {
      closeSessionMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom['session-menu'].hidden) {
      closeSessionMenu();
    }
  });
  // 滚动后菜单会悬在原位，直接关掉更符合直觉
  dom['session-list'].addEventListener('scroll', closeSessionMenu, { passive: true });
  window.addEventListener('blur', closeSessionMenu);
}

// 会话按「今天 / 昨天 / 过去 7 天 / 更早」分组：信息流从「一长串标题」变成「时间轴」，老会话不再靠滚动找
const SESSION_GROUPS = ['今天', '昨天', '过去 7 天', '更早'];

function sessionGroupOf(item) {
  const seconds = Number(item.update_time || 0);
  if (!seconds) {
    return SESSION_GROUPS[3];
  }
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const stamp = seconds * 1000;
  if (stamp >= todayStart) {
    return SESSION_GROUPS[0];
  }
  if (stamp >= todayStart - 86400000) {
    return SESSION_GROUPS[1];
  }
  if (stamp >= todayStart - 6 * 86400000) {
    return SESSION_GROUPS[2];
  }
  return SESSION_GROUPS[3];
}

// 顶部标题跟随当前会话（没有当前会话就是「新对话」）
function syncChatTitle() {
  const current = state.conversations.find((item) => item.id === state.conversationId);
  if (dom['chat-title']) {
    dom['chat-title'].textContent = (current && current.title) || '新对话';
    dom['chat-title'].title = (current && current.title) || '新对话';
  }
  // 历史窗口跟着换会话：按「会话 + 标题」去重，避免每次重画列表都发一次 IPC
  syncMemoryWindow();
}

function renderSessionList() {
  const list = dom['session-list'];
  // 整块重建会把滚动位置归零：每轮对话结束都会重画一次，用户翻到老会话时
  // 会看到列表被弹回顶部（看起来像「刚发的一句话把历史顶走了」）。重建前后各存/恢复一次
  const scrollTop = list.scrollTop;
  list.innerHTML = '';
  const rows = filteredConversations();
  syncChatTitle();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'session-empty';
    empty.textContent = state.conversations.length ? '没有找到匹配的会话' : '还没有对话';
    list.appendChild(empty);
    dom['session-empty'] = empty;
    // 搜索无命中但后端还有更早的：按钮照旧给出，否则用户以为真的没有这段对话
    renderLoadMore(list);
    list.scrollTop = scrollTop;
    return;
  }
  // 先统计每组条数，组标题右侧显示数量
  const counts = {};
  rows.forEach((item) => {
    const name = sessionGroupOf(item);
    counts[name] = (counts[name] || 0) + 1;
  });
  let group = '';
  let section = null;
  rows.forEach((item) => {
    const next = sessionGroupOf(item);
    if (next !== group) {
      group = next;
      const groupName = next;
      const collapsed = state.collapsedGroups.indexOf(groupName) >= 0;
      section = document.createElement('section');
      section.className = collapsed ? 'session-group is-collapsed' : 'session-group';
      section.dataset.group = groupName;
      const heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'session-group-title';
      heading.setAttribute('aria-expanded', String(!collapsed));
      const name = document.createElement('span');
      name.className = 'session-group-name';
      name.textContent = groupName;
      const count = document.createElement('span');
      count.className = 'session-group-count';
      count.textContent = String(counts[groupName] || 0);
      const arrow = document.createElement('span');
      arrow.className = 'session-group-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      heading.appendChild(name);
      heading.appendChild(count);
      heading.appendChild(arrow);
      heading.addEventListener('click', () => {
        const index = state.collapsedGroups.indexOf(groupName);
        if (index >= 0) {
          state.collapsedGroups.splice(index, 1);
        } else {
          state.collapsedGroups.push(groupName);
        }
        renderSessionList();
      });
      section.appendChild(heading);
      list.appendChild(section);
    }
    if (section) {
      section.appendChild(buildSessionItem(item));
    }
  });
  renderLoadMore(list);
  list.scrollTop = scrollTop;
}

// 把某个会话顶到最前：历史列表按「最后一次说话」排序，用户一发出消息就该生效，不必等模型答完
function touchConversationOrder(conversationId) {
  if (conversationId == null) {
    return false;
  }
  const target = state.conversations.find((item) => item.id === conversationId);
  if (!target) {
    return false;
  }
  target.update_time = Math.floor(Date.now() / 1000);
  state.conversations.sort(
    (a, b) => (b.update_time || 0) - (a.update_time || 0) || (b.id || 0) - (a.id || 0)
  );
  renderSessionList();
  return true;
}

async function loadConversations(options) {
  const opts = options || {};
  const retried = Boolean(opts.retried);
  // 轮询触发的补拉失败不弹条：离线横幅已经说明了原因，每 15 秒弹一条等于骚扰
  const quiet = Boolean(opts.quiet);
  try {
    const body = await requestJson(`/conversations?limit=${CONVERSATIONS_PAGE_SIZE}`);
    state.conversations = Array.isArray(body) ? body : []; // 裸数组（落定）
    // 满一页就认为后端还有更早的：后端不返回 total，只能靠这一条判断
    state.conversationsHasMore = state.conversations.length >= CONVERSATIONS_PAGE_SIZE;
    state.conversationsPaged = false;
    state.conversationsLoadingMore = false;
    // 「已加载」只在成功之后置位：以前在调用方发请求前就置 true，首屏失败一次就再也不重拉了
    state.conversationsLoaded = true;
    renderSessionList();
  } catch (error) {
    if (error && error.status === 401 && !retried) {
      // 令牌过期或失效：清理与提示已由 requestJson 统一做过，这里只负责降级成匿名再拉一次
      //（只重试一次，后端恒 401 时不会递归到底）
      return loadConversations({ retried: true, quiet });
    }
    // 失败回滚标志：让下一轮轮询（或手动重试）还能再拉，而不是把侧栏永久钉在占位上
    state.conversationsLoaded = false;
    state.conversationsLoadingMore = false;
    connection.updateAnimation(false); // 加载失败就别再闪了
    connection.refreshPlaceholder(); // 连不上就换成「明白话 + 重试」占位
    if (!quiet) {
      showToast(error && error.message ? error.message : '会话列表加载失败，请稍后重试');
    }
  }
}

// 会话列表底部：有更早就给按钮（请求中禁用 + 文案变「加载中…」），确实翻过页到底才给一行提示。
// 列表每次都是 innerHTML 清空重建，所以事件在这里绑，不用事件委托。
function renderLoadMore(list) {
  if (state.conversationsHasMore || state.conversationsLoadingMore) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-more';
    button.disabled = state.conversationsLoadingMore;
    button.textContent = state.conversationsLoadingMore ? '加载中…' : '加载更早的会话';
    button.addEventListener('click', () => loadMoreConversations());
    list.appendChild(button);
    return;
  }
  // 首屏本来就不满一页时不显示「没有更早的会话了」：那只是常识，不是信息
  if (state.conversationsPaged) {
    const done = document.createElement('p');
    done.className = 'session-empty';
    done.textContent = '没有更早的会话了';
    list.appendChild(done);
  }
}

async function loadMoreConversations() {
  if (state.conversationsLoadingMore || !state.conversationsHasMore) {
    return;
  }
  state.conversationsLoadingMore = true;
  renderSessionList(); // 立刻进 loading 态，别让用户以为没点中
  // keyset 游标：取已加载列表最后一条的 (update_time, id)。update_time 会被「又说了句话」改写，
  // 用 offset 时翻页期间有会话被更新就会重复或漏条；下面仍保留按 id 去重作为兜底
  const oldest = state.conversations[state.conversations.length - 1];
  const query = oldest
    ? `limit=${CONVERSATIONS_PAGE_SIZE}&before_time=${Number(oldest.update_time) || 0}&before_id=${oldest.id}`
    : `limit=${CONVERSATIONS_PAGE_SIZE}`;
  try {
    const body = await requestJson(`/conversations?${query}`);
    const rows = Array.isArray(body) ? body : [];
    // 去重与「还有没有更早」的判断在 lib/session-page.js（纯函数，单测覆盖重复/满页边界）
    const merged = window.SXWSessionPage.mergeConversationPage(
      state.conversations,
      rows,
      CONVERSATIONS_PAGE_SIZE
    );
    state.conversations = merged.items;
    state.conversationsPaged = true;
    state.conversationsHasMore = merged.hasMore;
  } catch (error) {
    // 失败不改 hasMore：按钮在 finally 里恢复可点，用户可以再试
    showToast(error && error.message ? error.message : '加载更早的会话失败，请稍后重试');
  } finally {
    state.conversationsLoadingMore = false;
    renderSessionList();
  }
}

// 登录前把匿名会话 id 扫全（逐页 offset），否则只认领首屏那一页，其余匿名会话永久失去归属。
// 必须在保存令牌之前调用：登录后的 /conversations 只返回新账号自己的会话，匿名列表就看不见了。
async function collectAnonymousConversationIds() {
  if (state.auth.token) {
    // 已登录时匿名列表不可见，只能沿用此前记下的那批
    return state.anonymousConversationIds.slice();
  }
  const ids = [];
  for (let page = 0; page < ANONYMOUS_SCAN_MAX_PAGES; page += 1) {
    const offset = ids.length;
    const body = await requestJson(
      `/conversations?limit=${CONVERSATIONS_PAGE_SIZE}&offset=${offset}`
    );
    const rows = Array.isArray(body) ? body : [];
    rows.forEach((item) => ids.push(item.id));
    if (rows.length < CONVERSATIONS_PAGE_SIZE) {
      break;
    }
  }
  return ids;
}

// 搜索框键盘导航：↑↓ 在命中结果间移动，Enter 打开，Esc 清空（与代码编辑器里的快速搜索一致）
function moveSearchNav(step) {
  const items = Array.from(dom['session-list'].querySelectorAll('.session-item'));
  if (!items.length) {
    return null;
  }
  items.forEach((item) => item.classList.remove('is-nav'));
  // 首次按 ↑ 要落在最后一条（从 -1 直接减会跳到倒数第二条）
  const base = state.searchNav < 0 ? (step > 0 ? -1 : 0) : state.searchNav;
  state.searchNav = (base + step + items.length) % items.length;
  const target = items[state.searchNav];
  target.classList.add('is-nav');
  target.scrollIntoView({ block: 'nearest' });
  return target;
}

function bindSessionList() {
  dom['btn-new-chat'].addEventListener('click', () => startNewChat());
  dom['input-search'].addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.searchKeyword = dom['input-search'].value;
      state.searchNav = -1;
      renderSessionList();
    }, SEARCH_DEBOUNCE_MS);
  });
  dom['input-search'].addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSearchNav(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = dom['session-list'].querySelector('.session-item.is-nav') || moveSearchNav(1);
      if (active) {
        active.click();
      }
      return;
    }
    if (event.key === 'Escape' && dom['input-search'].value) {
      event.preventDefault();
      window.clearTimeout(searchTimer);
      dom['input-search'].value = '';
      state.searchKeyword = '';
      state.searchNav = -1;
      renderSessionList();
    }
  });
}

// ===== 12. 会话切换·删除·新建（生成中禁切换） =====
function clearMessageArea() {
  Array.from(dom['message-list'].querySelectorAll('.msg-row, .msg-note, .msg-loading')).forEach((element) => {
    element.remove();
  });
  if (msgMoreButton) {
    msgMoreButton.remove();
    msgMoreButton = null;
  }
  // 消息都没了，会话内搜索的命中位置也失效：顺手清掉高亮
  clearChatSearch();
  // 正在朗读的那条消息已经不在 DOM 里：语音必须一起停，否则切会话后还在念上一条
  stopSpeaking();
  releaseAttachmentBlobs();
}

// 消息区顶部的「加载更早」：确实还有更早的才显示，请求中禁用并改文案
function updateEarlierButton() {
  const list = dom['message-list'];
  if (!state.messagesHasMore && !state.messagesLoadingMore) {
    if (msgMoreButton) {
      msgMoreButton.remove();
      msgMoreButton = null;
    }
    return;
  }
  if (!msgMoreButton) {
    msgMoreButton = document.createElement('button');
    msgMoreButton.type = 'button';
    msgMoreButton.className = 'msg-more';
    msgMoreButton.addEventListener('click', () => loadEarlierMessages());
  }
  msgMoreButton.disabled = state.messagesLoadingMore;
  msgMoreButton.textContent = state.messagesLoadingMore ? '加载中…' : '加载更早的消息';
  if (list.firstChild !== msgMoreButton) {
    list.insertBefore(msgMoreButton, list.firstChild);
  }
}

// 按 keyset（before_id）往前取一页，插到「加载更早」按钮之后、当前第一条消息之前；
// 插入后按高度差补偿滚动位置，让用户眼前那几条消息不跳
async function loadEarlierMessages() {
  const cid = state.conversationId;
  if (state.messagesLoadingMore || !state.messagesHasMore || !cid || !state.messagesOldestId) {
    return;
  }
  const list = dom['message-list'];
  state.messagesLoadingMore = true;
  updateEarlierButton();
  const prevHeight = list.scrollHeight;
  const prevTop = list.scrollTop;
  try {
    const body = await requestJson(
      `/conversations/${cid}/messages?limit=${MESSAGES_PAGE_SIZE}&before_id=${state.messagesOldestId}`
    );
    if (state.conversationId !== cid) {
      return; // 用户已切走：这一页直接丢弃
    }
    const items = Array.isArray(body) ? body : [];
    // 锚定在"当前第一条消息"上：每条新行都插在它之前，插入顺序即时间顺序
    const anchor = list.querySelector('.msg-row');
    const target = { container: list, before: anchor };
    items.forEach((item) => renderHistoryMessage(item, target));
    const oldest = items.find((item) => item.id != null);
    if (oldest) {
      state.messagesOldestId = oldest.id;
    }
    state.messagesHasMore = items.length >= MESSAGES_PAGE_SIZE && Boolean(oldest);
    // 内容变高多少就把滚动位置往下补多少（只补偿一次，避免逐条插入时抖动）
    list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
  } catch (error) {
    showToast(error && error.message ? error.message : '更早的消息加载失败，请稍后重试');
  } finally {
    state.messagesLoadingMore = false;
    if (state.conversationId === cid) {
      updateEarlierButton();
    }
  }
}

function showEmptyState() {
  clearMessageArea();
  setEmptyStateVisible(true);
}

function renderHistoryMessage(item, target) {
  if (item.role === 'user') {
    const raw = item.content || '';
    // 附件卡片优先用后端返回的元数据；老数据只有 `[上传文件] 文件名` 首行，降级成不可预览的卡片
    const split = splitUploadContent(raw);
    const cards = Array.isArray(item.attachments) ? item.attachments : [];
    let attachments = cards.map((card) => Object.assign({}, card));
    if (!attachments.length && split.name) {
      // 改造前上传的消息：库里没有附件记录与原文件，标注「未保存」而不是伪造一个 0 B 的可点卡片
      attachments = [{ name: split.name, mime: '', size: 0, kind: 'text', missing: true }];
    }
    appendUserMessage(split.text, attachments, raw, item.add_time, target);
    return;
  }
  // 历史消息自带当时用的模型名：换了模型之后旧回答不该显示成新模型
  const ai = appendAiMessage(item.add_time, 0, target, item.model);
  ai.update(item.content || '', false);
}

// 历史消息分帧渲染：一次同步插几十条 Markdown（含代码块）会让长会话切换时明显卡顿
function renderHistoryMessages(items, conversationId) {
  const CHUNK = 40;
  let index = 0;
  const step = () => {
    if (state.conversationId !== conversationId) {
      return; // 用户已切走，别把旧会话内容插进新会话
    }
    const end = Math.min(index + CHUNK, items.length);
    for (; index < end; index += 1) {
      renderHistoryMessage(items[index]);
    }
    if (index < items.length) {
      window.requestAnimationFrame(step);
    }
  };
  step();
}

async function switchConversation(conversationId) {
  if (conversationId === state.conversationId) {
    return;
  }
  if (state.generating) {
    notifyBusy('切换会话');
    return;
  }

  // 先落盘草稿：下面 applyDraft() 会把输入框换成新会话的草稿，
  // 而它会 clearTimeout 掉本会话的延迟写盘计时器 —— 不先 flush，刚打的字两边都没有
  flushDraft();
  // 附件属于上一条会话的上下文：切换时清掉，避免把 A 会话的文件发到 B 会话
  if (state.attachments.length) {
    clearAttachments();
  }
  clearMessageArea();
  setEmptyStateVisible(false);
  const loading = document.createElement('p');
  loading.className = 'msg-loading';
  loading.textContent = '正在加载…';
  dom['message-list'].appendChild(loading);

  const seq = ++conversationSeq;
  try {
    const body = await requestJson(
      `/conversations/${conversationId}/messages?limit=${MESSAGES_PAGE_SIZE}`
    );
    if (seq !== conversationSeq) {
      return; // 用户已点到别的会话：这次的结果丢弃，别把内容插进新会话
    }
    const items = Array.isArray(body) ? body : [];
    state.conversationId = conversationId;
    // 分页游标必须随会话重置：A 会话的「还有更早」不能带到 B
    const oldest = items.find((item) => item.id != null);
    state.messagesOldestId = oldest ? oldest.id : 0;
    state.messagesHasMore = items.length >= MESSAGES_PAGE_SIZE && Boolean(oldest);
    state.messagesLoadingMore = false;
    loading.remove();
    clearMessageArea();
    if (items.length) {
      setEmptyStateVisible(false);
      renderHistoryMessages(items, conversationId);
      updateEarlierButton();
    } else {
      showEmptyState();
    }
    renderSessionList();
    applyDraft();
  } catch (error) {
    if (seq !== conversationSeq) {
      return;
    }
    loading.remove();
    // 消息区上面已经被 clearMessageArea() 清空，而 state.conversationId 还停在旧会话：
    // 结果是白屏，且再点同一会话会被开头的「id 相同」直接 return，永远回不来。
    // 这里把当前会话归零（视图与状态重新一致），用户点任意会话都能重新加载。
    state.conversationId = null;
    state.messagesOldestId = 0;
    state.messagesHasMore = false;
    showEmptyState();
    showToast(error && error.message ? error.message : '会话内容加载失败，请稍后重试');
  }
}

async function deleteConversation(conversationId) {
  try {
    await requestJson(`/conversations/${conversationId}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter((item) => item.id !== conversationId);
    if (state.conversationId === conversationId) {
      state.conversationId = null;
      showEmptyState();
    }
    renderSessionList();
    notify('会话已删除', '聊天记录与附件已一并移除', 'ok');
  } catch (error) {
    showToast(error && error.message ? error.message : '删除失败，请稍后重试');
  }
}

function askDeleteConversation(item) {
  if (state.generating) {
    notifyBusy('删除会话');
    return;
  }
  openConfirm({
    title: '删除这个会话？',
    text: `「${item.title || '新的对话'}」的聊天记录与附件会一起删除。`,
    note: '删除不可撤销。想留着的话，先导出为 Markdown。',
    okText: '删除',
    onConfirm: () => deleteConversation(item.id)
  });
}

function startNewChat() {
  if (state.generating) {
    notifyBusy('新建对话');
    return;
  }
  flushDraft();
  state.conversationId = null;
  // 新会话没有更早的消息，游标一起清掉（否则空态下按钮还会被重建出来）
  state.messagesHasMore = false;
  state.messagesOldestId = 0;
  state.messagesLoadingMore = false;
  showEmptyState();
  renderSessionList();
  applyDraft();
  dom['input-message'].focus();
}

// ===== 13. 二次确认窗口（危险操作红色 + 二次确认；多开时各自认领自己的回调） ====
/**
 * 打开确认窗口，用户点「确定」时执行回调。
 *
 * 回调留在主窗口：确认窗口只回传 action，不执行删除 / 清除这类会写库的动作。
 * 每扇确认窗口按窗口 id 对应一个回调，所以「设置里删产物」和「列表里删会话」
 * 同时弹两个确认框时，点哪个都落到各自的动作上。
 */
function openConfirm(options) {
  const opts = options || {};
  askAppWindow('confirm', {
    title: opts.title || '请确认',
    text: opts.text || '',
    note: opts.note || '',
    okText: opts.okText || '确定',
    danger: opts.danger !== false
  }).then((result) => {
    if (!result || result.action !== 'confirm') {
      return;
    }
    if (typeof opts.onConfirm === 'function') {
      opts.onConfirm();
    }
  });
}

// ===== 14. 登录注册与用户卡片（账号接口 / 认领 / 登录与退出；弹窗样式见 index.html ====
// 用户卡片：未登录显示「访 / 未登录」，登录后显示后端下发的昵称与首字头像
function renderUserCard() {
  const logged = Boolean(state.auth.token);
  const name = logged ? state.auth.nickname || state.auth.username : '未登录';
  dom['user-name'].textContent = name;
  dom['user-name'].title = logged ? `${name}（${state.auth.username}）` : '当前是未登录状态';
  dom['user-avatar'].textContent = logged ? String(name).slice(0, 1) : '访';
  dom['user-avatar'].title = name;
  // 未登录时卡片右侧露一个「登录」提示，已登录换成账号菜单
  dom['login-hint'].hidden = logged;
  dom['user-card'].classList.toggle('is-guest', !logged);
  dom['btn-logout'].hidden = !logged;
  dom['btn-rename-user'].hidden = !logged;
  if (!logged) {
    hideUserMenu();
  }
}

function hideUserMenu() {
  dom['user-menu'].hidden = true;
}

// 卡片是账号入口：已登录弹菜单，未登录直接开登录弹窗（少一次找按钮）
function toggleUserMenu() {
  if (!state.auth.token) {
    openAuthWindow();
    return;
  }
  dom['user-menu'].hidden = !dom['user-menu'].hidden;
}

async function restoreAuth() {
  // 重启后按主进程加密保存的令牌直接恢复登录态（令牌文件不出主进程）
  let data = {};
  try {
    data = (window.desktopBridge && (await window.desktopBridge.readAuth())) || {};
  } catch (error) {
    data = {};
  }
  const token = typeof data.token === 'string' ? data.token : '';
  // 老版本的 auth.bin 只存了 token + username：昵称退回账号名，不显示空白
  const username = String(data.username || '');
  authExpiredNotified = false;
  state.auth = token
    ? {
        token,
        id: Number(data.id || 0),
        username,
        nickname: String(data.nickname || username),
        avatar: String(data.avatar || '')
      }
    : { token: '', id: 0, username: '', nickname: '', avatar: '' };
  renderUserCard();
}

// 返回写盘 promise：启动/登录这类需要「落盘后才有后续断言」的地方要 await，其余调用点可以不等
// remember=false 时只保留内存态并清掉磁盘旧令牌：下次启动就是未登录
function saveAuth(token, user, remember) {
  const info = user || {};
  const username = String(info.username || '');
  const nickname = String(info.nickname || username);
  state.auth = {
    token,
    id: Number(info.id || 0),
    username,
    nickname,
    avatar: String(info.avatar || '')
  };
  authExpiredNotified = false; // 重新登录成功：允许「登录已过期」下次再提示一次
  renderUserCard();
  if (!window.desktopBridge) {
    return Promise.resolve();
  }
  if (remember === false) {
    return window.desktopBridge.clearAuth().catch(() => {});
  }
  // 写盘失败不影响本次使用：内存态已经生效，下次启动重新登录即可
  return window.desktopBridge
    .writeAuth({ token, id: state.auth.id, username, nickname, avatar: state.auth.avatar })
    .catch(() => {});
}

function clearAuth(needToast) {
  state.auth = { token: '', id: 0, username: '', nickname: '', avatar: '' };
  state.anonymousConversationIds = [];
  renderUserCard();
  if (needToast) {
    notify('已退出登录', '已切回访客模式，仍可继续聊天', 'ok');
  }
  if (!window.desktopBridge) {
    return Promise.resolve();
  }
  return window.desktopBridge.clearAuth().catch(() => {});
}

/**
 * 登录窗口：只收集账号密码；请求、匿名会话认领、列表刷新仍在主窗口完成
 * （这条链路依赖 state.conversations 与 state.auth，复制一份必然漂移）。
 */
function openAuthWindow() {
  if (state.generating) {
    notifyBusy('登录');
    return;
  }
  hideUserMenu();
  openAppWindow('auth', { username: state.auth.username || '' }).then((opened) => {
    if (!opened) {
      return;
    }
    listenWindowResults(opened.id, (data) => {
      if (!data || data.action !== 'submit') {
        return;
      }
      runAsync('登录注册', () => submitAuth(data));
    });
  });
}

/** 把校验结果送回登录窗口：成功它自己关，失败在原位显示中文原因。 */
function replyAuth(packet) {
  const bridge = window.desktopBridge;
  if (bridge && typeof bridge.replyWindow === 'function') {
    bridge.replyWindow('auth', packet);
  }
}

// 登录后自动认领登录前的匿名会话（claim）。
// 必须分批：后端 schema 用 CLAIM_MAX_IDS 限长，一次塞超过就是 422，整批一条都认领不回来。
// 某一批失败不影响其它批，避免「第 3 批超时」把后面几十条一起丢掉。
async function claimAnonymousConversations() {
  const ids = state.anonymousConversationIds.slice();
  state.anonymousConversationIds = [];
  if (!ids.length || !state.auth.token) {
    return 0;
  }
  let claimed = 0;
  for (let start = 0; start < ids.length; start += CLAIM_BATCH_SIZE) {
    const batch = ids.slice(start, start + CLAIM_BATCH_SIZE);
    try {
      const body = await requestJson('/conversations/claim', {
        method: 'POST',
        json: { conversation_ids: batch }
      });
      claimed += Number((jsonPayload(body) || {}).claimed || 0);
    } catch (error) {
      showToast(error && error.message ? error.message : '登录前的对话认领失败，请稍后重试');
    }
  }
  return claimed;
}

// 提交登录 / 注册：非空由前端拦，格式与长度由后端校验（中文提示）
// 两个接口都直接返回令牌 + user：注册即登录，不再有「注册成功请再登一次」的中间态
async function submitAuth(input) {
  const tab = input && input.tab === 'register' ? 'register' : 'password';
  const username = String((input && input.username) || '').trim();
  const password = String((input && input.password) || '');
  const remember = !(input && input.remember === false);
  const payload = { username, password };
  if (tab === 'register' && input.nickname) {
    payload.nickname = input.nickname;
  }

  try {
    const body = await requestJson(tab === 'register' ? '/register' : '/login', {
      method: 'POST',
      json: payload
    });
    const data = jsonPayload(body) || {};
    if (!data.access_token) {
      replyAuth({ ok: false, error: '登录响应异常，请重启后端后重试' });
      return;
    }
    // 匿名 id 必须在 saveAuth 之前扫全：登录后接口只返回新账号自己的会话
    let anonymousIds = [];
    try {
      anonymousIds = await collectAnonymousConversationIds();
    } catch (error) {
      // 扫不全就退回当前已加载的那批：宁可少认领，也不能让登录本身失败
      anonymousIds = state.conversations.map((item) => item.id);
    }
    // 先答复再落盘：窗口收到 ok 立即关闭，认领与刷新在后台继续
    replyAuth({ ok: true });
    await saveAuth(data.access_token, Object.assign({ username }, data.user || {}), remember);
    state.anonymousConversationIds = anonymousIds;
    const greeting = tab === 'register' ? '已创建账号并登录' : '登录成功';
    const claimed = await claimAnonymousConversations();
    await loadConversations();
    notify(greeting, claimed > 0 ? `已认领 ${claimed} 段对话` : '会话已归到你的账号下', 'ok');
  } catch (error) {
    replyAuth({ ok: false, error: friendlyError(error) });
  }
}

function logout() {
  if (state.generating) {
    notifyBusy('退出登录');
    return;
  }
  clearAuth(true);
  // 退出登录要连同「上一个人的会话、搜索词、待发附件」一起清掉，否则会短暂显示别人的列表
  state.conversationId = null;
  state.conversations = [];
  // 已加载标志也要复位：否则下一个账号登录后，轮询会因为「加载过」而不再拉新账号的列表
  state.conversationsLoaded = false;
  // 分页游标一并复位：否则下一个人的列表会带着上一个人的「还有更早」状态
  state.conversationsHasMore = false;
  state.conversationsPaged = false;
  state.conversationsLoadingMore = false;
  state.searchKeyword = '';
  state.searchNav = -1;
  if (dom['input-search']) {
    dom['input-search'].value = '';
  }
  if (state.attachments.length) {
    clearAttachments();
  }
  renderSessionList();
  showEmptyState();
  runAsync('刷新会话列表', () => loadConversations());
}

// 改昵称：窗口自己完成 PATCH 并写回加密登录态，主窗口只同步卡片
function openNicknameWindow() {
  if (!state.auth.token) {
    return;
  }
  hideUserMenu();
  askAppWindow('nickname', { nickname: state.auth.nickname || '' }).then((result) => {
    if (!result || result.action !== 'saved') {
      return;
    }
    state.auth.nickname = String(result.nickname || '');
    renderUserCard();
    showToast(`昵称已改为：${state.auth.nickname}`);
  });
}

function bindAuthModal() {
  // 只有一个入口：整张账号卡片。未登录点它开登录窗口，已登录点它开账号菜单
  dom['user-card'].addEventListener('click', () => toggleUserMenu());
  dom['user-card'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleUserMenu();
    }
  });
  dom['btn-logout'].addEventListener('click', () => {
    hideUserMenu();
    logout();
  });
  dom['btn-rename-user'].addEventListener('click', () => openNicknameWindow());
  // 点菜单以外的地方收起菜单：卡片与菜单自身的点击不算「外面」
  document.addEventListener('click', (event) => {
    if (dom['user-menu'].hidden) {
      return;
    }
    if (dom['user-card'].contains(event.target) || dom['user-menu'].contains(event.target)) {
      return;
    }
    hideUserMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideUserMenu();
    }
  });
}

/**
 * 跨窗口同步：主窗口是「壳」，主题 / 字号 / 登录态 / 长任务状态都由别的窗口改。
 *
 * 统一在这里接主进程广播，新增窗口不需要在主窗口里单独接线：
 * 窗口只要用 bridge.writeConfig / writeAuth / restartBackend，主窗口就会自己跟上。
 */
function bindWindowSync() {
  const bridge = window.desktopBridge;
  if (!bridge) {
    return;
  }
  // 子窗口回传结果 / 未回结果就关窗：让「等结果」的 Promise 落地
  if (typeof bridge.onWindowResult === 'function') {
    bridge.onWindowResult((packet) => settleWindowRequest(packet));
  }
  if (typeof bridge.onWindowClosed === 'function') {
    bridge.onWindowClosed((packet) => {
      const id = packet && packet.windowId;
      if (!id) {
        return;
      }
      const resolve = windowRequests.get(id);
      if (resolve) {
        windowRequests.delete(id);
        resolve(null);
      }
      windowListeners.delete(id);
    });
  }
  // 登录态：登录窗口 / 改昵称窗口写盘后，左下角卡片立即更新，不需要重启
  if (typeof bridge.onAuthChanged === 'function') {
    bridge.onAuthChanged((auth) => {
      const data = auth || {};
      if (!data.token) {
        state.auth = { token: '', id: 0, username: '', nickname: '', avatar: '' };
        renderUserCard();
        return;
      }
      state.auth = {
        token: String(data.token),
        id: Number(data.id || 0),
        username: String(data.username || ''),
        nickname: String(data.nickname || data.username || ''),
        avatar: String(data.avatar || '')
      };
      renderUserCard();
    });
  }
  // 主题 / 字号：任一窗口改完，主窗口当场跟着变
  if (typeof bridge.onConfigChanged === 'function') {
    bridge.onConfigChanged((conf) => {
      if (!conf || typeof conf !== 'object') {
        return;
      }
      appConfig = Object.assign({}, appConfig, conf);
      if (conf.theme) {
        applyTheme(conf.theme);
      }
      if (conf.fontScale) {
        applyFontScale(conf.fontScale);
      }
    });
  }
  // 长任务：换库 / 恢复 / 清除期间后端不可用，发送入口先挡住（不盖遮罩，聊天区照常滚动）
  if (typeof bridge.onToolBusy === 'function') {
    bridge.onToolBusy((payload) => {
      // 自动备份是后台静默任务（用户没点任何按钮）：它期间后端仍可用，
      // 不能因为它把发送键禁掉——首启的新用户会以为「应用坏了，发不出消息」
      const quiet = payload && payload.tool === 'auto-backup';
      state.toolBusy = Boolean(payload && payload.busy) && !quiet;
      state.toolBusyText = (payload && payload.text) || '';
      updateComposer();
    });
  }
}

// ===== 15. 冒烟自检入口（只有主进程 --smoke 启动时才动态加载 smoke.js） =====
// 为什么不在 index.html 里静态引入：那会把整套场景代码打进生产包，等于给正式用户
// 装了一排可以驱动界面的测试入口。这里按需注入脚本，加载失败也只是自检跑不起来，
// 正式使用完全不受影响（package.json 的 build.files 也把它排除了）。
function loadSmokeModule() {
  return new Promise((resolve) => {
    if (window.SXWSmoke && typeof window.SXWSmoke.mount === 'function') {
      resolve(window.SXWSmoke);
      return;
    }
    const script = document.createElement('script');
    script.src = 'smoke.js';
    script.onload = () => resolve(window.SXWSmoke || null);
    script.onerror = () => {
      console.warn('[冒烟] smoke.js 加载失败，自检入口不可用');
      resolve(null);
    };
    document.head.append(script);
  });
}

/** 传给 smoke.js 的依赖：全是活引用（dom / state 是对象，函数是声明），运行期取到的就是最新状态。 */
function smokeDependencies() {
  return {
    dom,
    state,
    getConfig: () => appConfig,
    constants: { THEME_LIGHT, THEME_DARK },
    updateComposer,
    sendMessage,
    stopGenerating,
    pickAttachment,
    handleMenuAction,
    flushDraft,
    currentTheme,
    openChatSearch,
    runChatSearch,
    closeChatSearch,
    markdown: () => window.SXWMarkdown
  };
}

async function mountSmokeHooks() {
  const api = await loadSmokeModule();
  if (api && typeof api.mount === 'function') {
    api.mount(smokeDependencies());
  }
}

// ===== 16. 启动 =====
async function bootstrap() {
  cacheDom();
  const params = new URLSearchParams(window.location.search);
  // 冒烟入口：只有主进程 --smoke 启动（带 smoke=1）才动态加载，正式窗口不引入这段代码
  if (params.get('smoke') === '1') {
    await mountSmokeHooks();
  }
  if (window.desktopBridge) {
    appConfig = await window.desktopBridge.readConfig();
  }
  if (params.get('apiBase')) {
    appConfig.apiBase = params.get('apiBase'); // 冒烟专用：临时指向本机假后端
  }
  if (params.get('scenario')) {
    // 冒烟场景每次从「未登录」起跑（场景名由主进程透传），避免上次登录残留的令牌影响断言
    // 必须等清理落盘完成再读：主进程写 auth.bin 是异步的，抢跑会读到上一条令牌
    await clearAuth(false);
  }
  await restoreAuth();
  applyTheme(pickInitialTheme(params.get('theme')));
  applyFontScale(appConfig.fontScale);
  bindWindowControls();
  bindModelSelect();
  bindSessionMenu();
  bindComposer();
  bindMessageActions();
  bindAttachmentViewer();
  bindChatSearch();
  bindMoreMenu();
  bindEnhanceEntries();
  bindSidebarToggle();
  bindSidebarResizer();
  renderAttachments();
  bindAuthModal();
  bindSessionList();
  bindWindowSync();
  // 草稿是 300ms 防抖落盘的：打完字立刻点 × / Alt+F4 时最后一段输入会丢。
  // pagehide 覆盖关窗、刷新与进程退出，比 beforeunload 在 Electron 里更可靠
  window.addEventListener('pagehide', flushDraft);
  updateComposer();
  setConnection(null); // 首次进来先按「连接中」渲染占位，不再预铺三条骨架
  bindBackendReady(); // 先挂上再探：托管后端可能在这次探测过程中就绪
  connection.bind(); // 其它窗口换库/改地址/改模型后立刻跟随，不等轮询
  await checkConnection();
  scheduleConnectPoll(); // 在线 15s / 离线 5s 自动重连
}

// 初始化链没有兜底时，出错的表现是「窗口白屏、控制台什么都没有」
bootstrap().catch((error) => {
  console.error('[启动] 页面初始化失败', error);
  const note = document.createElement('p');
  note.className = 'boot-error';
  note.textContent = '界面初始化失败，请重启应用；若持续失败请看窗口控制台里的中文报错';
  document.body.appendChild(note);
});
