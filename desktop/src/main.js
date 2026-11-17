/**
 * 文件：desktop/src/main.js
 * 职责：桌面端主进程入口——创建无边框主窗口、注册窗口控制与配置读写通道、实现窗口显示三重兜底；
 *      提供原生菜单与快捷键、选文件与导出保存两类系统能力（渲染进程只能经 preload 调用）；
 *      带 `--smoke` 启动时执行自检并打印标记，供冒烟脚本判读；
 *      `SMOKE_SCENARIO` 可指定场景自检（断言实现在 renderer/app.js 段落 15）。
 * 口径：窗口尺寸、安全配置、快捷键与附件上限均以本文件顶部常量与 README 为准；
 *      本文件只提供系统能力，不判断文件格式（格式校验在后端）。
 */

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { fileURLToPath } = require('url');
const { createBackendManager } = require('./backend-manager');
const { isRevealAllowed, isOpenableAttachment } = require('./path-guard');
const {
  listArtifactsAsync,
  resolveArtifact,
  deleteArtifact,
  dirSizeAsync,
  revealMode
} = require('./artifacts');
const { toolCommand, toolEnv, parseLastJson } = require('./tool-run');
const { createLogFile } = require('./main-log');
const { checkDeleteTarget } = require('./delete-guard');

const { settingsOf, latestBackupTime, shouldAutoBackup, normalizeDays } = require('./auto-backup');
const storageForm = require('./storage-form');
const modelsConfig = require('./models-config');
const { createWindowManager, WINDOW_DEFS } = require('./app-windows');

// 允许环境变量覆盖 userData：打包态自检 / 多开验证必须能隔离，
// 否则一跑就写进真实的 config.env、备份与 data（`--user-data-dir` 对 app.getPath 不生效）。
// 必须在 app ready 之前设置，路径才会被 Electron 真正采用。
if (process.env.SUIXINWENDA_USER_DATA) {
  app.setPath('userData', process.env.SUIXINWENDA_USER_DATA);
}

// 1. 窗口与默认配置参数（唯一源：本段；改数值只改这里）
// 默认尺寸对齐设计稿画板 1180×720：留白比例、卡片宽度、输入坞位置都按这个比例定的
const WINDOW_WIDTH = 1180;
const WINDOW_HEIGHT = 720;
const WINDOW_MIN_WIDTH = 940;
const WINDOW_MIN_HEIGHT = 620;
// 首帧窗口底色必须与 styles.css 的 --bg 完全一致，否则每次启动都会闪一下别的颜色
const WINDOW_BG_LIGHT = '#ffffff'; // = styles.css :root --bg
const WINDOW_BG_DARK = '#0c0e10'; // = styles.css [data-theme='dark'] --bg
// 窗口/任务栏图标（唯一源：desktop/build/icon.ico，与 package.json build.win.icon 同一份）
// 只有 `npm start`（跑 node_modules/electron/dist/electron.exe）时才需要显式指定；
// 打包后的 exe 已把该图标写进可执行文件资源，此处路径不存在也无影响
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');
// 与 package.json 的 build.appId 保持一致：Windows 任务栏据此归组并显示正确图标
const APP_USER_MODEL_ID = 'io.github.suixinwenda.desktop';
const SHOW_FALLBACK_MS = 3000;
const SMOKE_HOLD_MS = 1500;
// 启动小窗尺寸（420×300）：只放 logo + 一行状态 + 一根进度线，再大就喧宾夺主
const SPLASH_WIDTH = 420;
const SPLASH_HEIGHT = 300;
// 小窗最短展示时长：复用外部后端时几百毫秒就好了，闪一下比完全不显示更廉价
const SPLASH_MIN_MS = 600;
// 后端启动失败时红字要停够时间，否则用户只看到一闪而过的报错
const SPLASH_FAIL_DWELL_MS = 1200;
// 退出小窗的最小展示时长：stop() 经常几十毫秒就返回，不等一下的话小窗在 ready-to-show 前
// 就被 destroy，用户根本看不到「正在退出」
const EXIT_SPLASH_MIN_MS = 400;
// 启动总兜底：无论后端怎么卡，主窗口都必须出现。
// 不变式：兜底 ≥ 就绪超时 × 1.4 —— 开发态就绪超时 30 秒 → 45 秒；打包态 60 秒 → 90 秒。
// 低于这个比例，失败提示还没停够（1.2 秒）就被兜底抢掉，用户只看到一闪而过的红字
const BOOT_MAX_MS = 45000;
const BOOT_MAX_MS_PACKAGED = 90000;
// 退出兜底：stop() 自带 2.5 秒优雅 + 1.5 秒 taskkill，8 秒留足余量
const SHUTDOWN_MAX_MS = 8000;
// 启动耗时基线：主窗口显示时打一行「用了多久」，用户反馈「开得慢」时才有据可查
const BOOT_STARTED_AT = Date.now();
const DEFAULT_CONFIG = {
  apiBase: 'http://127.0.0.1:8010',
  theme: 'light',
  fontScale: 'normal',
  // 定期自动备份：开关默认开、间隔默认 7 天（真值口径在 auto-backup.js，
  // 这里只是「配置里没有这两个键时」的落值）
  autoBackupEnabled: true,
  autoBackupDays: 7
};
// 主进程读取附件的字节上限（10 MB，唯一源）：仅防超大文件把内存吃满，最终校验仍在后端
const MAX_PICK_BYTES = 10485760;
// 导出文本上限（5 MB）：渲染进程传来的内容不可信
const MAX_EXPORT_CHARS = 5 * 1024 * 1024;
// 预览 / 另存附件时的 base64 长度上限（30 MB 原始数据对应的字符数）
const MAX_ATTACHMENT_BASE64 = Math.ceil((30 * 1024 * 1024 * 4) / 3);
// 一次最多选几个文件（与渲染进程 MAX_ATTACHMENTS 同源）：多选时超出部分直接不读，省内存
const MAX_PICK_FILES = 9;
// 选文件对话框的格式过滤（分组只为方便用户找文件，格式是否支持由后端 core/files.py 判定）
const PICK_FILTERS = [
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
  { name: '文档', extensions: ['pdf', 'docx', 'xlsx', 'xlsm', 'md', 'txt', 'csv', 'json'] },
  { name: '全部文件', extensions: ['*'] }
];
// 配置白名单：只允许改这几项，其余键一律丢弃，防止页面写脏配置
const CONFIG_KEYS = ['apiBase', 'theme', 'fontScale', 'autoBackupEnabled', 'autoBackupDays'];
// 存储表单的白名单与校验规则在 storage-form.js（纯函数、可单测）；这里只负责注入 fs
const THEMES = ['light', 'dark'];
// 正文字号三档，与渲染进程的 FONT_SCALES 同源
const FONT_SCALES = ['small', 'normal', 'large'];
// 接口地址只允许 http + 本机回环（仅本机使用）。
// 必须与 index.html 的 CSP `connect-src` 一致：https / IPv6 会被 CSP 拦掉，允许保存只会得到「永远连不上」
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];
const LOOPBACK_PROTOCOLS = ['http:'];
// 允许交给系统浏览器打开的外部协议（其余协议一律丢弃，防 file:// 与自定义协议被利用）
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);
// 图片后缀 → mime（渲染进程把 base64 还原成 Blob 时要用；与 图片一行同一份清单）
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
};

// 2. 启动开关（人工命令用：--smoke 自检、--dev 开发者工具）
const IS_SMOKE = process.argv.includes('--smoke');
const IS_DEV = process.argv.includes('--dev');
// 2a. 主进程文件日志：打包版没有控制台，用户报「卡在正在启动」时手上得有证据。
//     这里只建写入器，路径在第一次写时才算（冒烟换了 userData，见 2b）
const logFile = createLogFile({ app, isSmoke: IS_SMOKE, now: Date.now });
// 2b. 冒烟隔离：`--smoke` 用系统临时目录下的独立 userData，不碰用户正式配置
//     （`%APPDATA%\suixinwenda-desktop\config.json` 里的主题与接口地址），也不与正在运行的正式实例抢单实例锁；
//     目录名带 pid：并发跑多个冒烟场景时不会互相删 userData、抢配置文件
const SMOKE_USER_DATA = IS_SMOKE ? path.join(app.getPath('temp'), `suixinwenda-smoke-${process.pid}`) : '';
// 外部显式传了 --user-data-dir（如总冒烟脚本）时尊重外部选择，不再覆盖
const HAS_USER_DATA_FLAG = process.argv.some((arg) => arg.startsWith('--user-data-dir'));
if (SMOKE_USER_DATA && !HAS_USER_DATA_FLAG) {
  // 启动前清残留：退出时 Chromium 还占着文件句柄，删不掉是常态，
  // 留给下一次冒烟启动时清，temp 里不会堆一堆目录
  try {
    fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true });
  } catch (error) {
    // 上次进程没退干净时沿用旧目录，userData 脏一点不影响断言
  }
  app.setPath('userData', SMOKE_USER_DATA);
}
const SMOKE_SHOT = process.env.SMOKE_SHOT || '';
const SMOKE_SIZE = process.env.SMOKE_SIZE || '';
const SMOKE_QUERY = process.env.SMOKE_QUERY || '';
const SMOKE_SCENARIO = process.env.SMOKE_SCENARIO || '';
// 冒烟专用：用环境变量替代「选文件」「保存位置」两个系统弹窗，让自检能无人值守跑通附件与导出链路
const SMOKE_OPEN_FILE = process.env.SMOKE_OPEN_FILE || '';
const SMOKE_SAVE_PATH = process.env.SMOKE_SAVE_PATH || '';
// 恢复场景同样需要一个「用户选中的备份包」：冒烟不能弹系统对话框
const SMOKE_RESTORE_FILE = process.env.SMOKE_RESTORE_FILE || '';

// 2c. 主进程异常兜底：不接住的话，出错时窗口静默不弹，日志里什么都没有
process.on('uncaughtException', (error) => {
  console.error('[主进程] 未捕获异常', error);
  // 异常之后进程可能停在半初始化状态（窗口只建了一半、配置文件写了一半）继续响应 IPC 只会更糟：
  // 落完整堆栈 → 弹一次中文框 → 退出。冒烟模式必须跳过弹框与退出，否则自检会卡在对话框上。
  if (IS_SMOKE) {
    return;
  }
  try {
    dialog.showErrorBox('随心问答遇到内部错误', String((error && error.stack) || error));
  } catch (dialogError) {
    // 弹框本身失败（例如窗口还没就绪）不能再抛，否则退出路径被堵死
    console.error('[主进程] 错误提示弹窗失败', dialogError);
  }
  app.exit(1);
});
// 网络失败这类常见噪声不退出：真退会让应用在弱网下几乎没法用
process.on('unhandledRejection', (reason) => {
  console.error('[主进程] 未处理的 Promise 拒绝', reason);
});

// 3. 运行时状态
let mainWindow = null;
let shownBy = '';
let rendererErrorCount = 0;
let smokeFinished = false;
// 启动小窗与它的加载状态：状态推送必须等页面 did-finish-load，
// 早发的 send 会被直接丢掉，用户就永远停在初始文案上
let splashWindow = null;
let splashLoaded = false;
let splashPendingStatus = null;
let splashShownAt = 0;
// 主窗口关闭前的常规边界快照：退出小窗要回到用户最后看到的位置，
// 而不是无缘无故跳到主屏中央
let lastMainBounds = null;
// 显示闸门：非冒烟时启动阶段关闭，只有主流程（或兜底定时器）才放行，
// 否则 ready-to-show 会立刻把主窗口弹出来，启动小窗等于白做
let showGate = IS_SMOKE;
// 显示正在进行：showWindow 里为了补足小窗时长会先 await，
// 等待期间 isVisible() 还是 false，只能靠这个标记挡住第二个入口（单飞）
let showPending = false;
// 启动阶段标记：此时窗口全关（例如小窗被 Alt+F4）不代表用户想退出
let bootstrapping = true;
// 退出流程单入口标记：close / before-quit 都汇到 beginShutdown()
let shuttingDown = false;
// 后端就绪标记：页面可能比后端先加载完，这里记下来在 did-finish-load 时补发
let backendReadyFlag = false;
// 渲染进程崩溃后的自动重载时间窗：页面一加载就崩时靠它防刷屏，
// 但不能用「终身只重载一次」的布尔——那样第二次崩溃就永久白屏，没有任何兜底
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;
let lastReloadAt = 0;
const pendingTimers = []; // 冒烟与显示兜底的定时器句柄，窗口关闭时统一清掉

// 3b. 后端进程托管：谁拉起、谁负责关、配置从哪读，全部交给 backend-manager。
//     打包后走 resources/backend 下的 exe（extraResources 见 desktop/package.json），开发态走 uv run。
const BACKEND_DIR = path.join(__dirname, '..', '..', 'backend');

/**
 * 数据库密码的加解密（配置文件里只存密文）。
 *
 * Windows 上 safeStorage 走 DPAPI，密文只有同一用户账户能解开；系统没有可用密钥环时
 * （部分 Linux 桌面 / 精简 Windows）返回空串，由调用方退回明文并告警——
 * 与 userData/auth.bin 同一口径：宁可密码明文，也不要应用直接起不来。
 */
function encryptSecret(text) {
  if (!safeStorage.isEncryptionAvailable()) {
    logMain('warn', '[数据库密码] 系统加密不可用，密码按明文保存');
    return '';
  }
  try {
    return safeStorage.encryptString(text).toString('base64');
  } catch (error) {
    logMain('warn', `[数据库密码] 加密失败，按明文保存：${error.message}`);
    return '';
  }
}

function decryptSecret(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    return '';
  }
  try {
    return safeStorage.decryptString(Buffer.from(String(token || ''), 'base64'));
  } catch (error) {
    // 换机器 / 重装系统后旧密文解不开：返回空串，由上层回落到明文或提示重填密码
    console.warn(`[数据库密码] 解密失败（可能是换了机器或系统账户）：${error.message}`);
    return '';
  }
}

const backendManager = createBackendManager({
  app,
  backendDir: BACKEND_DIR,
  spawn: childProcess.spawn,
  execFile: childProcess.execFile,
  encrypt: encryptSecret,
  decrypt: decryptSecret
});

// 3d. 独立子窗口工厂：注册表与创建逻辑在 app-windows.js（可单测），
//     这里只注入 electron 实例、主题读取与「结果回传 → 主窗口」的出口。
const windowManager = createWindowManager({
  BrowserWindow,
  app,
  ipcMain,
  screen,
  rendererDir: path.join(__dirname, 'renderer'),
  preloadPath: path.join(__dirname, 'preload-window.js'),
  iconPath: ICON_PATH,
  getTheme: () => readConfig().theme,
  getMainWindow: () => mainWindow,
  isMainSender: isMainSender,
  // 子窗口同样只允许停在自己的本地页面：不允许被导航走、不允许开新窗口；
  // 同时把子窗口的控制台报错并入自检计数——否则视图里抛错，冒烟仍会打 PASS
  onWindowCreated: (win) => {
    hardenNavigation(win);
    win.webContents.on('console-message', (event, level, message) => {
      const newForm = event && typeof event.level === 'string';
      const levelValue = newForm ? event.level : level;
      const messageText = newForm ? event.message : message;
      if (levelValue === 'error' || levelValue === 3) {
        rendererErrorCount += 1;
        smokeLog(`[SMOKE] window-console-error=${messageText}`);
      }
    });
  },
  // 「窗口收集输入、主窗口执行」：登录 / 重命名 / 删除确认这类流程的最终动作仍留在 app.js。
  // windowId 必须带出去：确认框可多开，主窗口只能按窗口认领自己那一次挂起的回调。
  onResult: (view, data, win) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-window:result', {
        view,
        data,
        windowId: win && !win.isDestroyed() ? win.id : 0
      });
    }
  },
  // 窗口没回结果就被关掉：主窗口据此解除挂起，避免「点了没反应」的 Promise 永久悬空
  onClosed: (view, info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-window:closed', { view, windowId: (info && info.windowId) || 0 });
    }
  },
  log: (level, text, detail) => logMain(level, text, detail)
});

// 3c. 长任务互斥：备份 / 导出 / 清除 / 恢复 / 清理同一时间只能跑一个，且期间不许退出应用。
//     只在前端禁用按钮是不够的：快捷键、二次点击、IPC 重入都能绕过；
//     而工具子进程正在写库时窗口先没了，Electron 退了、子进程还在写。
//     状态源只有一个（activeTool），别拆成两套布尔——两套迟早有一边忘了复位。
let activeTool = '';
const TOOL_BUSY_MESSAGE = '正在执行备份/导出，请稍候';

/** 当前挡住退出的提示文案；空串表示没有长任务在跑。 */
function busyMessage() {
  if (!activeTool) {
    return '';
  }
  return activeTool === 'restore' ? '正在恢复数据，请等待完成' : TOOL_BUSY_MESSAGE;
}

function warnBusy() {
  if (IS_SMOKE || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  dialog
    .showMessageBox(mainWindow, { type: 'info', message: busyMessage(), buttons: ['知道了'], noLink: true })
    .catch(() => {});
}

/** 占住互斥再执行：占用时直接回繁忙，用 finally 保证释放。 */
async function withTool(name, task) {
  if (activeTool) {
    return { ok: false, error: TOOL_BUSY_MESSAGE };
  }
  activeTool = name;
  // 长任务期间后端在写库：通知所有窗口把「发消息 / 换库」这类入口先挡住。
  // 只广播状态，不盖遮罩——主窗口的聊天区要能继续滚动阅读。
  windowManager.broadcast('app:tool-busy', { busy: true, tool: name, text: busyMessage() });
  try {
    return await task();
  } finally {
    activeTool = '';
    windowManager.broadcast('app:tool-busy', { busy: false, tool: name });
  }
}

// 4. 基础工具：冒烟输出（只有 --smoke 才打印，正常启动保持安静）
function smokeLog(text) {
  if (IS_SMOKE) {
    console.log(text);
  }
}

/** 附加对象转一行文本：完整堆栈只进控制台与日志文件，不进小窗。 */
function detailText(detail) {
  if (detail instanceof Error) {
    return detail.stack || detail.message || '';
  }
  return String(detail);
}

/**
 * 主进程日志的统一出口：控制台照旧（冒烟判读依赖 stdout），同时落一份文件。
 * 打包版没有控制台，只打 console 等于什么都没留下。
 */
function logMain(level, text, detail) {
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (detail === undefined) {
    write(text);
  } else {
    write(text, detail);
  }
  logFile.log(level, detail === undefined ? text : `${text} ${detailText(detail)}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSmokeSize() {
  const matched = /^(\d{3,4})x(\d{3,4})$/.exec(SMOKE_SIZE);
  if (!matched) {
    return null;
  }
  return { width: Number(matched[1]), height: Number(matched[2]) };
}

// 冒烟时透传给页面的查询参数（例：SMOKE_QUERY="theme=dark&demo=1"）
// 场景名单独透传（页面据此从干净的未登录态起跑，见 renderer/app.js 段落 16）
function buildSmokeQuery() {
  // smoke=1 是页面挂载自检入口的开关（renderer/app.js 段落 15）：
  // 只有主进程 --smoke 启动才带，正常启动的页面不挂任何测试入口
  const query = { smoke: '1' };
  SMOKE_QUERY.split('&').forEach((pair) => {
    const index = pair.indexOf('=');
    if (index > 0) {
      query[pair.slice(0, index)] = pair.slice(index + 1);
    }
  });
  if (SMOKE_SCENARIO) {
    query.scenario = SMOKE_SCENARIO;
  }
  return query;
}

// 5. 配置读写：接口地址与主题存 userData/config.json
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 接口地址只放行 http + 本机回环，返回规范化字符串；不合法返回空串
function normalizeApiBase(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!LOOPBACK_PROTOCOLS.includes(parsed.protocol)) {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.includes(host)) {
      return '';
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    return '';
  }
}

// 只保留白名单键并校验取值，非法项直接丢弃（不整文件接受页面传来的任意 JSON）
function sanitizeConfigPatch(patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const clean = {};
  CONFIG_KEYS.forEach((key) => {
    if (!(key in source)) {
      return;
    }
    if (key === 'apiBase') {
      const apiBase = normalizeApiBase(source[key]);
      if (apiBase) {
        clean.apiBase = apiBase;
      }
      return;
    }
    if (key === 'theme' && THEMES.includes(source[key])) {
      clean.theme = source[key];
    }
    if (key === 'fontScale' && FONT_SCALES.includes(source[key])) {
      clean.fontScale = source[key];
    }
    // 开关必须是布尔：字符串 "false" 会被当真值，写成 `=== false` 才安全
    if (key === 'autoBackupEnabled' && typeof source[key] === 'boolean') {
      clean.autoBackupEnabled = source[key];
    }
    // 天数走 auto-backup 的归一口径：页面传 0 / 999 都收敛到合法范围，
    // 免得写进配置后每次启动都要再判一次边界
    if (key === 'autoBackupDays' && Number.isFinite(Number(source[key]))) {
      clean.autoBackupDays = normalizeDays(source[key]);
    }
  });
  return clean;
}

// 读原始配置文件（不做校验）；读不到或不是对象就当空配置
async function readRawConfig() {
  try {
    const text = await fs.promises.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(`[配置] 读取 config.json 失败：${error.message}`);
    }
    return {};
  }
}

// 配置内存缓存：createWindow() 在同步路径上要用主题定窗口底色（改了就得连锁处理
// 「首帧底色取不到 / 首次 IPC 竞态」，而这类问题冒烟测不出来），所以启动时 await 读一次进缓存，
// readConfig() 保持同步、只返回缓存。
let configCache = Object.assign({}, DEFAULT_CONFIG);

async function loadConfig() {
  const raw = await readRawConfig();
  // 旧配置里的接口地址若已不符合新口径（局域网 / https / 带路径），提示一次并回落默认值，
  // 不留「界面上是默认值、文件里还是旧值」的糊涂账
  if (raw.apiBase && !normalizeApiBase(raw.apiBase)) {
    console.warn(
      `[配置] 接口地址 ${raw.apiBase} 不受支持（仅允许 http://127.0.0.1 或 http://localhost），已回落到默认值`
    );
  }
  configCache = Object.assign({}, DEFAULT_CONFIG, sanitizeConfigPatch(raw));
  return Object.assign({}, configCache);
}

function readConfig() {
  return Object.assign({}, configCache);
}

// 写配置是「读-改-写」：并发写时后一次会拿着旧基线覆盖前一次，所以用一条串行 promise 链排队
let configWriteChain = Promise.resolve();

function writeConfig(patch) {
  const task = configWriteChain.then(() => writeConfigNow(patch));
  // 链条自身不能被一次失败打断（否则之后的写永远不执行）；错误照旧抛给调用方
  configWriteChain = task.catch(() => {});
  return task;
}

async function writeConfigNow(patch) {
  // 以文件原始内容为基线，只覆盖白名单键：避免把用户旧配置里的其它字段一起抹掉
  const merged = await readRawConfig();
  // 顺手自愈：文件里已经不合法（旧口径 / 手改坏）的键直接删掉，
  // 否则每次启动都会 warn 一次，且「文件里的值」与「界面用的值」长期不一致
  if ('apiBase' in merged && !normalizeApiBase(merged.apiBase)) {
    delete merged.apiBase;
  }
  if ('theme' in merged && !THEMES.includes(merged.theme)) {
    delete merged.theme;
  }
  const next = Object.assign(merged, sanitizeConfigPatch(patch));
  await writeJsonAtomic(configPath(), next);
  // 返回值与文件、与 readConfig() 三者保持一致
  configCache = Object.assign({}, DEFAULT_CONFIG, sanitizeConfigPatch(next));
  const snapshot = Object.assign({}, configCache);
  // 多窗口同步：主题 / 字号在任何窗口里改完，主窗口与其它窗口都要当场跟上
  windowManager.broadcast('app:config-changed', snapshot);
  return snapshot;
}

/** 登录态变化广播：登录窗口写盘后，主窗口的用户卡片要立即刷新。 */
function broadcastAuth() {
  readAuth()
    .then((auth) => windowManager.broadcast('app:auth-changed', auth))
    .catch(() => {});
}

/** 产物清单变化广播：备份 / 导出 / 删除 / 清理之后，设置窗口里的列表要跟着变。 */
function broadcastArtifacts() {
  windowManager.broadcast('app:artifacts-changed', {});
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename。
 *
 * 直写若在进程被杀 / 断电时留下半截 json，下次启动 readRawConfig() 会把它吞成空对象，
 * 再写一次配置就把已有设置洗没了。rename 后文件内容要么是旧的、要么是完整的。
 */
async function writeFileAtomic(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  // 同一进程内写是串行的，用 pid 区分临时文件名即可
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  return writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

// 5c. 登录态：令牌由 safeStorage 加密后写 userData/auth.bin。
//     为什么不放渲染进程的 localStorage：明文令牌落在任意页面脚本都能读的地方，
//     而它是本应用唯一的凭据；加密后渲染进程只拿到值、拿不到可读文件。
function authPath() {
  return path.join(app.getPath('userData'), 'auth.bin');
}

function encryptAuth(payload) {
  const text = JSON.stringify(payload);
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text);
  }
  // 系统没有可用密钥环（部分 Linux 桌面）时退化为明文：宁可保持能登录，也不要启动即崩
  logMain('warn', '[登录态] 系统加密不可用，令牌按明文保存');
  return Buffer.from(text, 'utf8');
}

function decryptAuth(buffer) {
  // 加密不可用期间写下的明文文件，在恢复加密后会解不开：按未登录处理即可（重新登录覆盖）
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return JSON.parse(safeStorage.decryptString(buffer));
    } catch (error) {
      console.warn(`[登录态] 解密失败，按未登录处理：${error.message}`);
      return null;
    }
  }
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    return null;
  }
}

async function readAuth() {
  // 昵称/头像一并存：重启后不用再按账号规则推导一遍（前后端各一套规则必然漂）
  const empty = { token: '', id: 0, username: '', nickname: '', avatar: '' };
  try {
    const buffer = await fs.promises.readFile(authPath());
    const parsed = decryptAuth(buffer);
    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) {
      return empty;
    }
    return {
      token: parsed.token,
      id: Number(parsed.id || 0),
      username: String(parsed.username || ''),
      nickname: String(parsed.nickname || ''),
      avatar: String(parsed.avatar || '')
    };
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(`[登录态] 读取失败：${error.message}`);
    }
    return empty;
  }
}

// 登录态的写 / 删串行化：两个窗口同时登录/登出时，直写与 unlink 交错会出现
// 「界面已登录但令牌文件被删」或反之。串行链只保证顺序，失败不阻塞后续操作。
let authWriteChain = Promise.resolve();

function queueAuthWrite(task) {
  const next = authWriteChain.then(task, task);
  authWriteChain = next.catch(() => {});
  return next;
}

async function removeAuthFile() {
  try {
    await fs.promises.unlink(authPath());
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(`[登录态] 清理失败：${error.message}`);
    }
  }
  broadcastAuth();
  return { ok: true };
}

async function clearAuthFile() {
  return queueAuthWrite(removeAuthFile);
}

async function writeAuth(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const token = typeof source.token === 'string' ? source.token : '';
  if (!token) {
    return clearAuthFile(); // 空令牌等于退出登录，别留一个加密过的空壳文件
  }
  const record = {
    token,
    id: Number(source.id || 0),
    username: typeof source.username === 'string' ? source.username : '',
    nickname: typeof source.nickname === 'string' ? source.nickname : '',
    avatar: typeof source.avatar === 'string' ? source.avatar : ''
  };
  return queueAuthWrite(async () => {
    try {
      // 必须原子写：直写途中被杀/断电会留下半截密文，解密失败就按「未登录」处理，
      // 用户会静默掉登录态（重新登录可恢复，但没有任何提示）
      await writeFileAtomic(authPath(), encryptAuth(record));
      broadcastAuth();
      return { ok: true };
    } catch (error) {
      console.warn(`[登录态] 写入失败：${error.message}`);
      return { ok: false };
    }
  });
}

// 6. 窗口控制通道（渲染进程只能通过 preload 暴露的方法调用）
// 6a. 来源校验：只认「本应用的窗口 + 该窗口自己的入口页」
//     白名单有两类：主窗口固定是 renderer/index.html；独立子窗口由 app-windows.js 在创建时登记
//     （renderer/app-window.html）。两个条件都要满足：发送者是已登记的窗口；页面路径与该窗口
//     该加载的入口文件一致（query 允许，冒烟会带 ?smoke=1 之类的参数）。
//     这样既不再用「只要 file:// 就全放行」的宽口径，也不会因为多开窗口而漏掉子窗口的 IPC。
let entryFilePath = '';

/** 是不是主窗口在说话：window:* 这类只属于主窗口的动作（最小化主窗口）靠它兜住。 */
function isMainSender(event) {
  const sender = event && event.sender;
  return Boolean(mainWindow) && !mainWindow.isDestroyed() && Boolean(sender) && sender.id === mainWindow.webContents.id;
}

function isTrustedSender(event) {
  const sender = event && event.sender;
  if (!sender) {
    return false;
  }
  const expected = isMainSender(event) ? entryFilePath : windowManager.entryOf(sender.id);
  if (!expected) {
    return false;
  }
  const frameUrl = event.senderFrame ? String(event.senderFrame.url || '') : '';
  if (!frameUrl) {
    return false;
  }
  try {
    // fileURLToPath 会忽略 query / hash，并处理 Windows 盘符与百分号编码（路径含空格也能比）
    return path.resolve(fileURLToPath(frameUrl)).toLowerCase() === expected.toLowerCase();
  } catch (error) {
    return false; // 连 URL 都解析不了，肯定不是自己的页面
  }
}

/** 三类产物的根目录：手动备份、数据导出、结构升级前的自动备份。 */
function artifactRoots() {
  const userData = app.getPath('userData');
  // 与 core/db_info.data_dir() 口径一致：开发态 backend/data，打包后 userData/data
  const dataDir = app.isPackaged
    ? path.join(userData, 'data')
    : path.join(__dirname, '..', '..', 'backend', 'data');
  return [
    { kind: 'backup', dir: path.join(userData, 'backups') },
    { kind: 'export', dir: path.join(userData, 'exports') },
    { kind: 'auto-backup', dir: path.join(dataDir, 'backups') }
  ];
}

// 备份 / 导出的产物清单存在 config.json 的 artifacts 数组里。
// 为什么要记绝对路径：用户可以存到桌面或 D 盘，不记下来就既看不到也删不掉。
// 渲染进程写不了这个数组（sanitizeConfigPatch 只认五个白名单键），只有主进程能增删。
const MAX_ARTIFACT_RECORDS = 50;
const ARTIFACT_KIND_LABELS = {
  backup: '手动备份',
  export: '数据导出',
  // 这一池现在有三种来源：升级前 / 恢复前 / 定期（before-auto）。
  // 统一叫「自动备份」：写成「升级前」会让定期备份在界面上显得来源不明。
  'auto-backup': '自动备份'
};

/**
 * 记录即授权：这份清单由主进程写，渲染进程改不了（sanitizeConfigPatch 只有五个白名单键）。
 *
 * 这里只做「必须是绝对路径、必须指向某个具体子项」的合法性检查，不限制文件名前缀——
 * 导出目录名允许用户自定义（比如「我的数据」），用前缀过滤会把这类记录直接丢掉。
 */
function artifactRecordsOf(raw) {
  const list = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  return list.filter((item) => {
    if (!item || typeof item.id !== 'string' || typeof item.kind !== 'string') {
      return false;
    }
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) {
      return false;
    }
    // 盘符根 / 顶层目录不许当成可删产物（dirname 等于自己是根）
    return path.dirname(item.path) !== item.path && path.basename(item.path).length > 0;
  });
}

async function readArtifactRecords() {
  return artifactRecordsOf(await readRawConfig());
}

// 产物清理：只清「本应用生成的备份与导出」，不含升级前 / 恢复前的自动备份——
// 那是回滚用的包，由 prune_backups 按份数管理，让用户手动清很容易误删。
const CLEAN_OLD_DEFAULT_DAYS = 30;
const CLEAN_SKIP_KINDS = new Set(['auto-backup']);

/**
 * 列出「超过 days 天没动过」的产物。
 *
 * 判定标准是「在不在本应用的产物清单里」，不是文件名前缀：
 * suixinwenda-* 只是默认名，导出目录允许用户改成「我的数据」，
 * 按前缀过滤会让这类（往往最大的）产物永远清不掉。
 * 判龄一律用 mtime：记录里的 createdAt 是入库时间，扫描侧是 mtime，两套语义混用会误删。
 *
 * 这里直接读目录，不复用 listArtifactItems：那条路有两层 20 条截断
 * （artifacts.js 的 MAX_ITEMS + 出口的 slice），30 天前的老产物正好被切掉。
 */
async function collectOldArtifacts(days) {
  const cutoff = Date.now() - days * 86400000;
  const records = await readArtifactRecords();
  const seen = new Set();
  const items = [];

  const push = (entry) => {
    const key = path.resolve(entry.path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    items.push(entry);
  };

  for (const record of records) {
    if (CLEAN_SKIP_KINDS.has(record.kind)) {
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(record.path);
    } catch (error) {
      continue; // 已经不在的交给「移除记录」，清理不该顺手删记录
    }
    if (stat.mtimeMs > cutoff) {
      continue;
    }
    push({
      id: record.id,
      kind: record.kind,
      name: path.basename(record.path),
      path: record.path,
      size: stat.isDirectory() ? await dirSizeAsync(record.path) : stat.size,
      mtime: Math.round(stat.mtimeMs)
    });
  }

  for (const root of artifactRoots()) {
    if (CLEAN_SKIP_KINDS.has(root.kind)) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(root.dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        continue;
      }
      if (stat.mtimeMs > cutoff) {
        continue;
      }
      push({
        id: `scan:${root.kind}/${entry.name}`,
        kind: root.kind,
        name: entry.name,
        path: full,
        size: entry.isDirectory() ? await dirSizeAsync(full) : stat.size,
        mtime: Math.round(stat.mtimeMs)
      });
    }
  }
  // 最旧的排前面：确认弹窗里先看到的就是「最该清掉的那个」
  items.sort((left, right) => left.mtime - right.mtime);
  return items;
}

/** 先给清单（不传 confirm），确认后才删：不可逆操作必须有一步「看清再动手」。 */
async function cleanOldArtifacts(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const days =
    Number.isFinite(Number(opts.days)) && Number(opts.days) > 0
      ? Math.floor(Number(opts.days))
      : CLEAN_OLD_DEFAULT_DAYS;
  const items = await collectOldArtifacts(days);
  const bytes = items.reduce((sum, item) => sum + item.size, 0);
  if (!opts.confirm) {
    return { ok: true, days, items, count: items.length, bytes };
  }

  let removed = 0;
  let freed = 0;
  const failed = [];
  const removedIds = [];
  for (const item of items) {
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      removed += 1;
      freed += item.size;
      if (!item.id.startsWith('scan:')) {
        removedIds.push(item.id);
      }
    } catch (error) {
      failed.push(item.name);
    }
  }
  if (removedIds.length) {
    const drop = new Set(removedIds);
    await mutateArtifacts((list) => list.filter((item) => !drop.has(item.id))).catch(() => {});
  }
  if (removed > 0) {
    broadcastArtifacts();
  }
  return { ok: true, days, count: items.length, removed, freed, failed };
}

/** 读-改-写产物清单，与配置写共用同一条串行链，避免并发覆盖。 */
async function mutateArtifacts(mutator) {
  const task = configWriteChain.then(async () => {
    const raw = await readRawConfig();
    raw.artifacts = mutator(artifactRecordsOf(raw)).slice(0, MAX_ARTIFACT_RECORDS);
    await writeJsonAtomic(configPath(), raw);
  });
  configWriteChain = task.catch(() => {});
  return task;
}

async function recordArtifact(entry) {
  const record = {
    id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: entry.kind,
    path: entry.path,
    // 两个库的产物会出现在同一个列表里：不记后端名，用户分不清哪份属于哪个库
    backend: typeof entry.backend === 'string' ? entry.backend : '',
    createdAt: Date.now()
  };
  await mutateArtifacts((list) => [record, ...list]);
  return record;
}

/** 列表 = 记录里的（任意路径）+ 固定目录里没被记录的（旧版本产物、自动备份）。 */
async function listArtifactItems() {
  const records = await readArtifactRecords();
  const items = [];
  const known = new Set();

  for (const record of records) {
    let stat = null;
    try {
      stat = fs.statSync(record.path);
    } catch (error) {
      // 文件被移动或删除：保留记录并标记 missing，不静默清理——
      // 「历史版本凭空消失」比「显示一条已失效的记录」更让人困惑
      stat = null;
    }
    if (stat) {
      known.add(path.resolve(record.path));
    }
    const backendLabel =
      record.backend === 'mysql' ? 'MySQL' : record.backend === 'sqlite' ? 'SQLite' : '';
    items.push({
      id: record.id,
      kind: record.kind,
      label: `${ARTIFACT_KIND_LABELS[record.kind] || record.kind}${backendLabel ? `（${backendLabel}）` : ''}`,
      name: path.basename(record.path),
      path: record.path,
      isDir: stat ? stat.isDirectory() : false,
      size: stat ? (stat.isDirectory() ? await dirSizeAsync(record.path) : stat.size) : 0,
      createdAt: record.createdAt || 0,
      missing: !stat
    });
  }

  for (const scan of await listArtifactsAsync(artifactRoots())) {
    if (known.has(path.resolve(scan.path))) {
      continue;
    }
    items.push({
      ...scan,
      id: `scan:${scan.id}`,
      label: ARTIFACT_KIND_LABELS[scan.kind] || scan.label,
      missing: false
    });
  }
  items.sort((left, right) => right.createdAt - left.createdAt);
  return items.slice(0, 20);
}

/**
 * 记录里的路径来自「主进程自己写的清单 + 用户选的目录」，本应由我们自己保证。
 * 但 config.json 是磁盘上的普通文件，被手改坏或写脏时，一次 rmSync recursive
 * 就可能删掉用户主目录。删除前再做一层与业务无关的保护：根目录、受保护目录、
 * 符号链接一律不碰。
 */
function guardDeleteTarget(target) {
  // 判定逻辑在 delete-guard.js（纯函数、有单测）：这里只负责注入 electron 的路径与 fs
  const verdict = checkDeleteTarget(target, {
    fs,
    path,
    protectedPaths: protectedSystemPaths()
  });
  if (!verdict.ok) {
    throw new Error(verdict.error);
  }
  return verdict.path;
}

/**
 * 导出落点的保护范围：只挡系统目录与盘符根。
 *
 * 不能复用 protectedSystemPaths 的完整列表：用户把导出存到「文档」是完全正常的需求，
 * 而导出只新建一个 suixinwenda-* 子目录、不删除任何东西，拦下来只会让人困惑。
 */
function protectedWriteRoots() {
  return [process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean)
    .map((item) => path.resolve(item).toLowerCase());
}

/** 用户级 / 系统级目录：不能当产物删除（删除是递归且不可逆的）。 */
function protectedSystemPaths() {
  return [
    app.getPath('userData'),
    app.getPath('appData'),
    app.getPath('home'),
    app.getPath('temp'),
    app.getPath('downloads'),
    app.getPath('documents'),
    app.getPath('desktop'),
    process.env.WINDIR,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData
  ]
    .filter(Boolean)
    .map((item) => path.resolve(item).toLowerCase());
}

async function deleteArtifactById(id) {
  if (typeof id !== 'string') {
    return { ok: false, error: '非法的删除目标' };
  }
  // 扫描出来的：仍按「只能删固定根目录下的直接子项」校验
  if (id.startsWith('scan:')) {
    return deleteArtifact(artifactRoots(), id.slice(5));
  }
  const record = (await readArtifactRecords()).find((item) => item.id === id);
  if (!record) {
    return { ok: false, error: '找不到这条记录（可能已被删除）' };
  }
  let target;
  try {
    target = guardDeleteTarget(record.path);
  } catch (error) {
    logMain('warn', `[产物] 拒绝删除不安全的目标：${record.path}（${error.message}）`);
    return { ok: false, error: `删除被拒绝：${error.message}` };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: `删除失败：${error.message}` };
  }
  await mutateArtifacts((list) => list.filter((item) => item.id !== id)).catch(() => {});
  broadcastArtifacts();
  return { ok: true, id };
}

/** 文件被移动后重新定位：只更新记录里的路径，不动文件。 */
async function relocateArtifact(id) {
  const record = (await readArtifactRecords()).find((item) => item.id === id);
  if (!record) {
    return { ok: false, error: '找不到这条记录' };
  }
  const wantDir = record.kind === 'export';
  const options = {
    title: wantDir ? '选择导出目录的新位置' : '选择备份文件的新位置',
    properties: wantDir ? ['openDirectory'] : ['openFile']
  };
  const chosen = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (chosen.canceled || !chosen.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  const picked = chosen.filePaths[0];
  let stat;
  try {
    stat = fs.statSync(picked);
  } catch (error) {
    return { ok: false, error: '选中的路径读不到' };
  }
  if (wantDir && !stat.isDirectory()) {
    return { ok: false, error: '导出记录需要选一个目录' };
  }
  if (!wantDir && stat.isDirectory()) {
    return { ok: false, error: '备份记录需要选一个文件' };
  }
  await mutateArtifacts((list) =>
    list.map((item) => (item.id === id ? { ...item, path: picked } : item))
  );
  broadcastArtifacts();
  return { ok: true, path: picked };
}

/** 只删记录、不删文件：用于「文件已经不在」的条目，让用户自己清理列表。 */
async function forgetArtifact(id) {
  const records = await readArtifactRecords();
  if (!records.some((item) => item.id === id)) {
    return { ok: false, error: '找不到这条记录' };
  }
  await mutateArtifacts((list) => list.filter((item) => item.id !== id));
  broadcastArtifacts();
  return { ok: true, id };
}

/**
 * 打开某个产物：
 * - 目录（导出）→ 直接进入该目录，用户想看的是里面的 jsonl
 * - 文件（备份 zip）→ 定位到所在文件夹并选中它，直接打开 zip 反而会弹压缩软件
 */
function revealTarget(target) {
  const mode = revealMode(target);
  if (!mode) {
    return { ok: false, error: '路径已不存在' };
  }
  if (mode === 'open') {
    // openPath 返回空字符串表示成功，非空是错误信息
    shell.openPath(target).then((message) => {
      if (message) {
        shell.showItemInFolder(target);
      }
    });
    return { ok: true };
  }
  shell.showItemInFolder(target);
  return { ok: true };
}

/** 默认保存位置：优先用上次选过的目录，没有才回落到应用数据目录。 */
async function saveDefaults() {
  const raw = await readRawConfig();
  const dirs = raw.saveDirs && typeof raw.saveDirs === 'object' ? raw.saveDirs : {};
  const userData = app.getPath('userData');
  const pick = (value, fallback) =>
    typeof value === 'string' && path.isAbsolute(value) ? value : fallback;
  return {
    backupDir: pick(dirs.backup, path.join(userData, 'backups')),
    exportDir: pick(dirs.export, path.join(userData, 'exports'))
  };
}

/** 记住这次选的位置，下次打开弹窗直接预填。 */
async function rememberSaveDir(mode, dir) {
  if (!['backup', 'export'].includes(mode) || !path.isAbsolute(dir)) {
    return;
  }
  const task = configWriteChain.then(async () => {
    const raw = await readRawConfig();
    const dirs = raw.saveDirs && typeof raw.saveDirs === 'object' ? raw.saveDirs : {};
    dirs[mode] = dir;
    raw.saveDirs = dirs;
    await writeJsonAtomic(configPath(), raw);
  });
  configWriteChain = task.catch(() => {});
  return task;
}

/** 系统目录选择框：只返回路径，不直接执行任何操作。 */
async function pickDirectory(title) {
  const safeTitle =
    typeof title === 'string' && title.trim() ? title.trim().slice(0, 40) : '选择保存位置';
  const options = {
    title: safeTitle,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('userData')
  };
  const chosen = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (chosen.canceled || !chosen.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  return { ok: true, dir: chosen.filePaths[0] };
}

/**
 * 校验 MySQL 连接表单与切换 patch：规则本体在 storage-form.js，这里只注入 fs。
 * 主进程是最后一道闸，渲染进程的校验只为当场说清楚。
 */
function sanitizeStorageForm(patch) {
  return storageForm.sanitizeStorageForm(patch, { existsSync: (file) => fs.existsSync(file) });
}

function sanitizeRestartPatch(patch) {
  return storageForm.sanitizeRestartPatch(patch, { existsSync: (file) => fs.existsSync(file) });
}

const probeEnv = storageForm.probeEnv;

/**
 * 测一组 MySQL 连接参数是否可用（真正的实现在 backend/tools/storage_test.py）。
 *
 * 参数走环境变量而不是命令行：命令行在本机任何进程列表里都看得见，等于把口令写进系统日志。
 */
async function testStorage(patch) {
  const clean = sanitizeStorageForm(patch);
  if (clean.error) {
    return { ok: false, error: clean.error, version: '', empty: null, rows: 0 };
  }
  return runTool('storage_test', [], {
    label: '测试连接',
    timeout: 30000,
    // TLS 主机名豁免与运行时同源：探测若比实际连接更严，会出现「测试失败但其实能连」
    env: Object.assign({}, probeEnv(clean.values), {
      SUIXINWENDA_PROBE_SSL_NO_VERIFY_IDENTITY: envValue('DB_SSL_NO_VERIFY_IDENTITY')
    })
  });
}

/**
 * 选一个备份包（只返回路径，不做任何操作）。
 *
 * 渲染进程拿不到 path 模块，也无法校验路径是否存在，所以校验留在主进程。
 */
async function pickBackupFile() {
  if (IS_SMOKE && SMOKE_RESTORE_FILE) {
    return fs.existsSync(SMOKE_RESTORE_FILE)
      ? { ok: true, path: SMOKE_RESTORE_FILE }
      : { ok: false, error: '冒烟用的备份文件不存在' };
  }
  const options = {
    title: '选择备份包',
    properties: ['openFile'],
    filters: [{ name: '备份', extensions: ['zip'] }],
    defaultPath: app.getPath('userData')
  };
  const chosen = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (chosen.canceled || !chosen.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  const picked = chosen.filePaths[0];
  if (!path.isAbsolute(picked) || !fs.existsSync(picked)) {
    return { ok: false, error: '选中的路径读不到' };
  }
  return { ok: true, path: picked };
}

/**
 * 从备份 zip 或导出目录恢复。
 *
 * 三道保护：
 * 1. 后端由外部进程拉起（start.ps1）时直接拒绝——stop() 对它是空操作、start() 又立刻返回，
 *    不拦住就等于在一份活着、还在被读写的后端上做整库写入。
 * 2. 工具跑完后 start() 失败不能覆盖恢复结果：数据已经恢复好了，把它报成「失败」用户会重做一遍。
 * 3. 期间 activeTool 非空，退出与其它工具都被挡住（见 busyMessage）。
 */
async function restoreStorage(payload) {
  const source = payload && typeof payload.from === 'string' ? payload.from : '';
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) {
    return { ok: false, error: '请先选择一个存在的备份文件或导出目录' };
  }
  const uploadsRaw = payload && typeof payload.uploadsFrom === 'string' ? payload.uploadsFrom : '';
  const uploadsFrom =
    uploadsRaw && path.isAbsolute(uploadsRaw) && fs.existsSync(uploadsRaw) ? uploadsRaw : '';
  const force = Boolean(payload && payload.force);

  const status = await backendManager.status();
  if (status.running && !backendManager.ownsProcess()) {
    return { ok: false, error: '后端由外部进程启动，请先关掉它再恢复' };
  }
  const restored = await runRestoreWithStop(status, source, uploadsFrom, force);
  if (restored && restored.ok) {
    // 恢复换了整份数据：所有窗口里的会话、产物、存储信息都过期了
    windowManager.broadcast('app:backend-restarted', { ok: true, reason: 'restore' });
    broadcastArtifacts();
  }
  return restored;
}

/** 停掉自己托管的后端 → 跑恢复工具 → 无条件把后端拉回来（失败只作为 warning 回传）。 */
async function runRestoreWithStop(status, source, uploadsFrom, force) {
  const args = ['--from', source];
  if (uploadsFrom) {
    args.push('--uploads-from', uploadsFrom);
  }
  if (force) {
    args.push('--force');
  }
  let result = null;
  try {
    if (status.running) {
      await backendManager.stop();
    }
    // 恢复可能要打包几十 MB 附件并整库重写：给足 10 分钟
    result = await runTool('restore', args, { label: '恢复', timeout: 600000 });
  } catch (error) {
    result = { ok: false, error: `恢复失败：${(error && error.message) || error}` };
  } finally {
    try {
      await backendManager.start();
    } catch (error) {
      const reason = (error && error.message) || String(error);
      // start() 失败是抛异常：直接让它冒出去会盖掉 IPC 返回值，渲染端只会看到「后端无法启动」，
      // 恢复结果（尤其是 pre_backup 路径）就丢了
      result =
        result && result.ok
          ? { ...result, warning: `恢复成功，但后端未能启动：${reason}` }
          : {
              ...(result || { ok: false }),
              error: `${(result && result.error) || '恢复失败'}（后端也未能启动：${reason}）`
            };
    }
  }
  return result;
}

async function revealArtifactById(id) {
  if (typeof id !== 'string') {
    return { ok: false, error: '非法的路径' };
  }
  if (id.startsWith('scan:')) {
    const found = resolveArtifact(artifactRoots(), id.slice(5));
    if (!found) {
      return { ok: false, error: '非法的路径' };
    }
    return revealTarget(found.path);
  }
  const record = (await readArtifactRecords()).find((item) => item.id === id);
  if (!record || !fs.existsSync(record.path)) {
    return { ok: false, error: '文件已不存在' };
  }
  return revealTarget(record.path);
}

/**
 * 本地时间戳 `YYYYMMDD-HHMMSS`。
 *
 * 不用 toISOString：那是 UTC，中国时区下会与用户看到的时间差 8 小时。
 * 与渲染进程的默认名、后端自动备份（before-upgrade-<backend>-YYYYMMDD-HHMMSS）保持同一格式。
 */
function localStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}

/** 目录名：去掉路径分隔符与 Windows 非法字符，其余（含中文）保留。 */
function normalizeArtifactName(value) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') {
    return '';
  }
  return text.replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
}

/** 保存位置：必须是绝对路径；相对路径一律视为「没给」，回落到默认目录。 */
function normalizeArtifactDir(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) {
    return '';
  }
  return path.normalize(text);
}

/** 文件名：去掉路径分隔符与非法字符，保留用户输入的中文。 */
function normalizeArtifactFileName(value) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..') {
    return '';
  }
  return text.replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
}

/**
 * 跑一个 `backend/tools/*` 工具子进程，返回它吐的那一行 JSON。
 *
 * env 必须显式传：工具子进程是独立进程，只能靠 SUIXINWENDA_ENV_FILE 找到当前这份配置。
 * 不传的话 core/config.py 会去程序旁边找 .env（打包态还不存在），静默回落到默认 SQLite——
 * 于是「备份/清除/恢复」操作的是另一个库，而且全程没有任何报错。
 */
function runTool(name, args, options) {
  const opts = options || {};
  const label = opts.label || '操作';
  let command;
  try {
    command = toolCommand({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      backendDir: BACKEND_DIR,
      name,
      args
    });
  } catch (error) {
    return Promise.resolve({ ok: false, error: error.message });
  }
  const env = toolEnv(process.env, {
    envFile: backendManager.envFilePath(),
    // 打包态与 artifactRoots() 同口径（userData/data）；开发态必须传空串——
    // load_env() 是「已存在不覆盖」，注进 backend/data 会压住用户自己的 DATA_DIR
    dataDir: app.isPackaged ? path.join(app.getPath('userData'), 'data') : '',
    // 配置文件里是密文，工具子进程要的是明文：解密后经环境变量注入
    dbPassword: backendManager.dbPassword()
  });
  Object.assign(env, opts.env || {});
  const timeoutMs = opts.timeout || 120000;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const child = childProcess.execFile(
      command.cmd,
      command.args,
      // 不用 execFile 自带的 timeout：它只对直接子进程发信号，`uv run python` 会派生
      // python 子进程，父进程被杀后它还在写库/占端口，超时形同没超时
      { cwd: command.cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        settled = true;
        const parsed = parseLastJson(stdout);
        if (error) {
          // 工具用非零退出码表达失败，但失败原因只写在 stdout 的那行 JSON 里；
          // 以前这里直接取 stderr（通常是空串），用户只看到一句「操作失败」
          if (parsed && typeof parsed === 'object') {
            resolve(parsed);
            return;
          }
          resolve({
            ok: false,
            error: String(stderr || error.message || `${label}失败`).trim().slice(0, 300)
          });
          return;
        }
        if (!parsed || typeof parsed !== 'object') {
          resolve({ ok: false, error: `${label}输出无法解析：${String(stdout).slice(0, 200)}` });
          return;
        }
        resolve(parsed);
      }
    );
    timer = setTimeout(() => {
      killToolTree(child);
      // 再给回调 1.5 秒收尾：杀进程树是异步的，立刻返回会让「已超时」与
      // 「工具其实刚成功」两个结果打架。仍然不回来就直接超时返回，Promise 不悬空。
      setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          ok: false,
          error: `${label}超时（${Math.round(timeoutMs / 1000)} 秒），已终止`
        });
      }, 1500);
    }, timeoutMs);
  });
}

/** 杀掉工具子进程及其派生的子进程（Windows 上必须 /T，否则 python 子进程会留下来继续写库）。 */
function killToolTree(child) {
  const pid = child && child.pid;
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      childProcess.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch (error) {
    logMain('warn', `[工具] 终止超时进程失败：${error.message}`);
  }
}

/** 「最近一份备份」要看哪些目录：手动备份与自动备份两处都算（两处都是用户的退路）。 */
function backupScanDirs() {
  return artifactRoots()
    .filter((root) => root.kind === 'backup' || root.kind === 'auto-backup')
    .map((root) => root.dir);
}

/**
 * 定期自动备份：后端就绪后静默跑一次，条件不满足就什么都不做。
 *
 * 为什么必须静默：用户没有主动点任何按钮，弹窗/进度条都会变成骚扰；
 * 但失败要留一行日志——不然「说好每 7 天备一次」在需要时才发现一份都没有。
 *
 * 复用 withTool：自动备份期间退出会拦下，避免写了一半的包被留在磁盘上；
 * 同一时间也只允许一个长任务（用户正好手动备份时这里会拿到繁忙，跳过即可）。
 */
async function autoBackupIfDue() {
  if (IS_SMOKE) {
    return { skipped: 'smoke' }; // 冒烟不往用户目录写包
  }
  const settings = settingsOf(readConfig());
  if (!settings.enabled) {
    return { skipped: 'disabled' };
  }
  const lastAt = latestBackupTime(backupScanDirs(), { fs });
  if (!shouldAutoBackup({ enabled: true, days: settings.days, lastAt, now: Date.now() })) {
    logMain('info', `[自动备份] 已有 ${settings.days} 天内的备份，本次跳过`);
    return { skipped: 'fresh' };
  }
  logMain('info', `[自动备份] 距上次备份已超过 ${settings.days} 天（或无备份），开始生成`);
  const result = await withTool('auto-backup', () =>
    runTool('backup', ['--prefix', 'before-auto'], { label: '自动备份', timeout: 300000 })
  );
  if (!result || !result.ok) {
    logMain('warn', `[自动备份] 未完成：${(result && result.error) || '未知原因'}`);
    return result || { ok: false };
  }
  logMain('info', `[自动备份] 已生成：${result.path}（附件 ${result.files || 0} 个）`);
  return result;
}

/**
 * 生成一份备份（数据库快照 + 附件）。
 *
 * 为什么走子进程而不是在渲染进程里下载：备份要读 SQLite/MySQL 与整个附件目录，
 * 那是后端的能力；渲染进程只该拿到「成功/失败 + 文件在哪」。
 */
async function createBackup(rawDir, rawFileName) {
  const stamp = localStamp();
  // 位置与文件名都由渲染进程的弹窗给出（先选位置、再填名字），这里只做校验
  const baseDir = normalizeArtifactDir(rawDir) || path.join(app.getPath('userData'), 'backups');
  const fileName = normalizeArtifactFileName(rawFileName) || `suixinwenda-${stamp}.zip`;
  if (!fileName.toLowerCase().endsWith('.zip')) {
    return { ok: false, error: '备份文件名需要以 .zip 结尾' };
  }
  const target = path.join(baseDir, fileName);
  if (fs.existsSync(target)) {
    return { ok: false, error: `该文件已存在：${target}。换个文件名再试` };
  }
  try {
    await fs.promises.mkdir(baseDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: `无法创建目标目录：${error.message}` };
  }
  const parsed = await runTool('backup', ['--out', target], { label: '备份' });
  if (!parsed.ok) {
    return parsed;
  }
  // 必须等记录写完再返回：否则页面紧接着刷新列表会读不到这条新产物
  await Promise.all([
    recordArtifact({ kind: 'backup', path: target, backend: parsed.backend }).catch(() => {}),
    rememberSaveDir('backup', baseDir).catch(() => {})
  ]);
  broadcastArtifacts();
  return { ...parsed, path: target };
}

/**
 * 一键清除当前存储的全部会话数据（账号保留）。
 *
 * 走独立子进程 + --yes：这条路径不可逆，不能让任何常规请求顺带触发；
 * 页面已经在确认弹窗里说明过范围，这里只负责执行。
 */
async function purgeStorage() {
  const result = await runTool('purge', ['--yes'], { label: '清除' });
  if (result && result.ok) {
    // 库被清空：主窗口的会话列表与当前会话都作废，必须整体重置
    windowManager.broadcast('app:backend-restarted', { ok: true, reason: 'purge' });
    broadcastArtifacts();
  }
  return result;
}

/**
 * 把当前库导出成 JSONL + manifest（换库、长期归档用）。
 *
 * 与备份的区别：备份是「整库快照 + 附件、用于回滚」，导出是「结构化数据、用于搬移」。
 */
async function exportData(rawDir, rawName) {
  const stamp = localStamp();
  // 位置与目录名都由弹窗给出：用户先看到「存到哪」，不会出现「不知道会不会被新建目录」
  const baseDir = normalizeArtifactDir(rawDir) || path.join(app.getPath('userData'), 'exports');
  // 落点校验：导出会 mkdir+p 写文件，而 dir 是渲染进程传来的。
  // 用户目录之外（系统目录、盘符根）一律拒绝，避免页面被注入后往任意位置写内容。
  const resolvedBase = path.resolve(baseDir);
  if (path.dirname(resolvedBase) === resolvedBase) {
    return { ok: false, error: '不能导出到磁盘根目录，请选择一个文件夹' };
  }
  const baseLower = resolvedBase.toLowerCase();
  const blocked = protectedWriteRoots().some(
    (root) => baseLower === root || baseLower.startsWith(`${root}${path.sep}`)
  );
  if (blocked) {
    return { ok: false, error: '不能导出到系统目录，请换一个位置' };
  }
  const folderName = normalizeArtifactName(rawName) || `suixinwenda-${stamp}`;
  const outDir = path.join(resolvedBase, folderName);
  if (fs.existsSync(outDir)) {
    return { ok: false, error: `该文件夹已存在：${outDir}。换个名字再试` };
  }
  const parsed = await runTool('export', ['--out', outDir], { label: '导出' });
  if (!parsed.ok) {
    return { ...parsed, path: outDir };
  }
  // 同上：先落盘记录，再回结果，页面刷新列表才看得到
  await Promise.all([
    recordArtifact({ kind: 'export', path: outDir, backend: parsed.backend }).catch(() => {}),
    rememberSaveDir('export', baseDir).catch(() => {})
  ]);
  broadcastArtifacts();
  return { ...parsed, path: outDir };
}

// ---- 模型配置：每个模型自带 Base URL 与 Key（用户自己添加，不走 .env） ----
function modelsConfigPath() {
  return path.join(app.getPath('userData'), 'models.json');
}

function readModelsConfig() {
  const file = modelsConfigPath();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return null; // 不存在：新用户首次启动
  }
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.models)) {
      throw new Error('结构不对');
    }
    return data;
  } catch (error) {
    // 坏文件不能静默当空配置：下次保存会整份覆盖，用户填过的所有 Key 一起消失。
    // 改名留档 + 日志留证据，至少还有手工恢复的机会。
    const backup = `${file}.corrupt-${localStamp()}`;
    try {
      fs.renameSync(file, backup);
      logMain('warn', `[模型] models.json 无法解析，已另存为 ${path.basename(backup)}：${error.message}`);
    } catch (renameError) {
      logMain('warn', `[模型] models.json 无法解析且另存失败：${renameError.message}`);
    }
    return null;
  }
}

function saveModelsConfig(config) {
  const file = modelsConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return config;
}

/** 读 env 文件里的某个键（只用于把老用户的 Key 迁移进 models.json）。 */
function envValue(key) {
  try {
    const text = fs.readFileSync(backendManager.envFilePath(), 'utf8');
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : '';
  } catch (error) {
    return '';
  }
}

/**
 * 首次启动 / 老用户升级：生成模型配置。
 *
 * 预置模板只带地址与模型 ID，Key 一律等用户自己填；
 * 但 .env 里已经有 Key 的老用户不该被要求重填——这里把它们加密搬进来，之后以 models.json 为准。
 */
function ensureModelsConfig() {
  const existing = readModelsConfig();
  if (existing) {
    return existing;
  }
  const config = modelsConfig.defaultConfig();
  [
    ['deepseek', 'DEEPSEEK_API_KEY'],
    ['qwen', 'DASHSCOPE_API_KEY']
  ].forEach(([provider, key]) => {
    const value = envValue(key);
    const encrypted = value ? encryptSecret(value) : '';
    const index = config.models.findIndex((item) => item.provider === provider);
    if (index >= 0 && encrypted) {
      config.models[index].apiKeyEnc = encrypted;
    }
  });
  const firstWithKey = config.models.find((item) => item.apiKeyEnc);
  config.default = firstWithKey ? firstWithKey.id : '';
  return saveModelsConfig(config);
}

/**
 * 把加密配置转成后端能读的明文运行时文件（退出时删除）。
 * 后端启动时读它构建模型注册表，所以每次改动后都要先同步、再重启。
 */
function syncRuntimeModels() {
  const config = ensureModelsConfig();
  const payload = modelsConfig.runtimePayload(config, decryptSecret);
  if (!payload.models.length) {
    // 空清单不能写成文件：childEnv 只要文件存在就注入 SUIXINWENDA_MODELS_FILE，
    // 后端会因为「有文件但 0 个模型」不再回退到 .env 里的两模型，聊天直接全挂。
    // 同时清掉上一轮残留，避免退出前的清单继续生效。
    backendManager.removeRuntimeModels();
    return payload;
  }
  backendManager.applyModels(payload);
  return payload;
}

/** 模型配置改动后重启后端：模型注册表只在启动时构建一次。 */
async function restartForModels() {
  return withTool('models', async () => {
    const result = await backendManager.restart({});
    return { ok: Boolean(result && result.ok), error: (result && result.error) || '' };
  });
}

/** 统一的「改配置 → 落盘 → 同步运行时文件 → 重启」流程，四个入口共用。 */
async function commitModelsChange(mutator) {
  const config = ensureModelsConfig();
  const result = mutator(config);
  if (result.error) {
    return { ok: false, error: result.error };
  }
  saveModelsConfig(result.config);
  const payload = syncRuntimeModels();
  const restart = await restartForModels();
  const output = {
    ok: restart.ok,
    error: restart.error,
    models: payload.models.length,
    config: modelsConfig.publicConfig(result.config)
  };
  // 模型改名 / 增删 / 换默认之后，主窗口的模型下拉与设置窗口的列表都要重新拉一次
  windowManager.broadcast('app:models-changed', output.config || null);
  return output;
}

function registerIpc() {
  // 独立子窗口的通道（app-window:*）在工厂里注册，这里只保证启动时注册一次
  windowManager.registerIpc();
  // 冒烟专用：让主窗口脚本驱动子窗口（断言挂载、点按钮、读文案）。
  // 只在 --smoke 下注册；正式包里这个通道根本不存在，主窗口也就无法借此跨窗口执行代码。
  if (IS_SMOKE) {
    ipcMain.handle('smoke:window', (event, view, code) => {
      if (!isMainSender(event)) {
        smokeLog('[SMOKE] window-eval-denied');
        return { ok: false, error: 'denied' };
      }
      const win = windowManager.findByView(String(view));
      if (!win) {
        smokeLog(`[SMOKE] window-eval-missing=${view}`);
        return { ok: false, error: 'missing' };
      }
      return win.webContents
        .executeJavaScript(String(code), true)
        .then((value) => ({ ok: true, value }))
        .catch((error) => {
          smokeLog(`[SMOKE] window-eval-error=${view}:${(error && error.message) || 'eval-failed'}`);
          return { ok: false, error: (error && error.message) || 'eval-failed' };
        });
    });
    ipcMain.handle('smoke:windows', (event) => {
      if (!isMainSender(event)) {
        return [];
      }
      return windowManager.listWindows().map((item) => item.view);
    });
  }
  // window:* 是「主窗口自己的窗控按钮」：子窗口必须走 app-window:*，
  // 否则子窗口点最小化会把主窗口收走
  ipcMain.on('window:minimize', (event) => {
    if (!isMainSender(event)) {
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });
  ipcMain.on('window:toggle-maximize', (event) => {
    if (!isMainSender(event)) {
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on('window:close', (event) => {
    if (!isMainSender(event)) {
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });
  ipcMain.handle('window:is-maximized', (event) =>
    isMainSender(event) ? Boolean(mainWindow) && mainWindow.isMaximized() : false
  );
  ipcMain.handle('config:read', (event) =>
    isTrustedSender(event) ? readConfig() : Object.assign({}, DEFAULT_CONFIG)
  );
  ipcMain.handle('config:write', (event, patch) => (isTrustedSender(event) ? writeConfig(patch) : readConfig()));
  // 登录态：渲染进程只能经此读写，令牌文件本身不出主进程
  ipcMain.handle('auth:read', (event) =>
    isTrustedSender(event) ? readAuth() : { token: '', id: 0, username: '', nickname: '', avatar: '' }
  );
  ipcMain.handle('auth:write', (event, payload) =>
    isTrustedSender(event) ? writeAuth(payload) : { ok: false }
  );
  ipcMain.handle('auth:clear', (event) => (isTrustedSender(event) ? clearAuthFile() : { ok: false }));
  // 后端状态：页面只读，托管动作一律留在主进程
  ipcMain.handle('backend:status', (event) =>
    isTrustedSender(event)
      ? backendManager.status()
      : { running: false, managed: false, ok: false, backend: null, location: null }
  );
  // 备份 / 导出：保存位置与名称都由渲染进程的弹窗给出，主进程只做校验与执行。
  // 全部经 withTool：同一时间只允许一个长任务，否则两个子进程会同时往同一个库/目录写
  ipcMain.handle('backup:create', (event, dir, fileName) =>
    isTrustedSender(event)
      ? withTool('backup', () => createBackup(dir, fileName))
      : { ok: false, error: '不允许的调用来源' }
  );
  ipcMain.handle('export:create', (event, dir, name) =>
    isTrustedSender(event)
      ? withTool('export', () => exportData(dir, name))
      : { ok: false, error: '不允许的调用来源' }
  );
  // 一键清除：不可逆，只接受来自本窗口的调用
  ipcMain.handle('storage:purge', (event) =>
    isTrustedSender(event) ? withTool('purge', () => purgeStorage()) : { ok: false, error: '不允许的调用来源' }
  );
  // 恢复：先停托管的后端再跑独立工具（见 restoreStorage 里的三道保护）
  ipcMain.handle('path:pick-file', (event) =>
    isTrustedSender(event) ? pickBackupFile() : { ok: false, error: '不允许的调用来源' }
  );
  ipcMain.handle('storage:restore', (event, payload) =>
    isTrustedSender(event)
      ? withTool('restore', () => restoreStorage(payload))
      : { ok: false, error: '不允许的调用来源' }
  );
  ipcMain.handle('save:defaults', (event) =>
    isTrustedSender(event) ? saveDefaults() : { backupDir: '', exportDir: '' }
  );
  ipcMain.handle('path:pick-directory', (event, title) =>
    isTrustedSender(event) ? pickDirectory(title) : { ok: false, error: '不允许的调用来源' }
  );
  // 打开某个产物所在的位置（只读操作：不删、不写）
  // 白名单 = 产物根目录 + 产物记录里的路径：`shell.openPath` 对 .exe 就是执行，
  // 而这条通道接受渲染进程传来的任意字符串，不收敛等于把「任意程序执行」开放出去
  ipcMain.handle('path:reveal', async (event, target) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '不允许的调用来源' };
    }
    if (typeof target !== 'string' || !path.isAbsolute(target) || !fs.existsSync(target)) {
      return { ok: false, error: '路径不存在' };
    }
    const allowed = artifactRoots()
      .map((root) => root.dir)
      .concat((await readArtifactRecords()).map((item) => item.path));
    if (!isRevealAllowed(target, allowed)) {
      return { ok: false, error: '这个路径不在本应用的产物范围内' };
    }
    return revealTarget(target);
  });
  // 产物管理：列举 / 删除 / 在资源管理器中定位。
  // 记录里的产物可以在任意路径（用户存到桌面也能删），但仍要求名字是我们生成的；
  // 扫描出来的产物则只能删固定根目录下的直接子项。
  ipcMain.handle('artifact:list', async (event) =>
    isTrustedSender(event) ? { ok: true, items: await listArtifactItems() } : { ok: false, items: [] }
  );
  ipcMain.handle('artifact:delete', (event, id) =>
    isTrustedSender(event) ? deleteArtifactById(id) : { ok: false, error: '不允许的调用来源' }
  );
  ipcMain.handle('artifact:reveal', (event, id) =>
    isTrustedSender(event) ? revealArtifactById(id) : { ok: false, error: '不允许的调用来源' }
  );
  // 文件被移动：更新记录路径，不搬文件
  ipcMain.handle('artifact:relocate', (event, id) =>
    isTrustedSender(event) ? relocateArtifact(id) : { ok: false, error: '不允许的调用来源' }
  );
  // 文件已不在：只移除记录，不碰磁盘
  ipcMain.handle('artifact:forget', (event, id) =>
    isTrustedSender(event) ? forgetArtifact(id) : { ok: false, error: '不允许的调用来源' }
  );
  // 清理 N 天前的产物：不带 confirm 只回清单，带 confirm 才真删
  ipcMain.handle('artifact:clean-old', (event, options) =>
    isTrustedSender(event)
      ? withTool('clean', () => cleanOldArtifacts(options))
      : { ok: false, error: '不允许的调用来源', items: [] }
  );
  // 测试连接：五个值只走子进程环境变量（口令不进命令行）
  ipcMain.handle('storage:test', (event, patch) =>
    isTrustedSender(event)
      ? withTool('storage_test', () => testStorage(patch))
      : { ok: false, error: '不允许的调用来源', version: '', empty: null, rows: 0 }
  );
  // 切换存储：白名单只有 DB_BACKEND + 几个 DB_*，页面传不了别的配置
  ipcMain.handle('backend:restart', async (event, patch) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '不允许的调用来源' };
    }
    const clean = sanitizeRestartPatch(patch);
    if (clean.error) {
      return { ok: false, error: clean.error };
    }
    return withTool('storage', async () => {
      // 切到 MySQL 前先探一次：不探的话，密码错 / 库不存在 / 端口不通全都会表现成
      // 「切换失败，已回到原存储：后端进程已退出」，用户只能自己去翻日志。
      // 探测用的是同一份参数与同一套中文翻译，和「测试连接」结果完全一致
      if (clean.patch.DB_BACKEND === 'mysql') {
        const probe = await runTool('storage_test', [], {
          label: '切换前检查',
          timeout: 30000,
          env: probeEnv(clean.patch)
        });
        if (!probe || !probe.ok) {
          return { ok: false, error: `切换前检查未通过：${(probe && probe.error) || '连接失败'}` };
        }
      }
      // 备份/导出/恢复进行中不许重启：两个子进程会同时动同一个库
      // 重启期间所有窗口都该被挡住：主窗口盖遮罩，其它窗口的光标也会被这层遮罩解释
      windowManager.broadcast('app:tool-busy', { busy: true, text: '正在切换存储，后端重启中…' });
      let result;
      try {
        result = await backendManager.restart(clean.patch);
      } finally {
        windowManager.broadcast('app:tool-busy', { busy: false });
      }
      // 换库之后当前会话与列表都属于旧库：通知所有窗口整体重置（主窗口据此清空并重拉）
      windowManager.broadcast('app:backend-restarted', {
        ok: Boolean(result && result.ok),
        patch: clean.patch
      });
      return result;
    });
  });
  // 模型：每个模型自带 Base URL 与 Key；改动后立刻同步运行时文件并重启后端
  ipcMain.handle('models:list', (event) => {
    if (!isTrustedSender(event)) {
      return { models: [], default: '', presets: [] };
    }
    // presets 由主进程下发：模板只在 models-config.js 维护一份，避免前后端各写一套
    return { ...modelsConfig.publicConfig(ensureModelsConfig()), presets: modelsConfig.TEMPLATES };
  });
  ipcMain.handle('models:save', async (event, payload) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '不允许的调用来源' };
    }
    const input = payload && typeof payload === 'object' ? payload : {};
    return commitModelsChange((config) =>
      input.id
        ? modelsConfig.updateModel(config, String(input.id), input, { encrypt: encryptSecret })
        : modelsConfig.addModel(config, input, { encrypt: encryptSecret })
    );
  });
  ipcMain.handle('models:delete', async (event, id) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '不允许的调用来源' };
    }
    return commitModelsChange((config) => modelsConfig.deleteModel(config, String(id || '')));
  });
  ipcMain.handle('models:default', async (event, id) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '不允许的调用来源' };
    }
    return commitModelsChange((config) => modelsConfig.setDefaultModel(config, String(id || '')));
  });
  ipcMain.handle('models:clear-key', async (event, id) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '不允许的调用来源' };
    }
    return commitModelsChange((config) => modelsConfig.clearModelKey(config, String(id || '')));
  });
  ipcMain.handle('file:pick', (event) => (isTrustedSender(event) ? pickAttachment() : { canceled: true }));
  ipcMain.handle('file:save-markdown', (event, options) =>
    isTrustedSender(event) ? saveMarkdown(options) : { canceled: true }
  );
  // 附件预览 / 另存：渲染进程只给 base64 与文件名，绝对路径不出主进程
  ipcMain.handle('attachment:open', (event, payload) =>
    isTrustedSender(event) ? openAttachment(payload) : { error: ATTACHMENT_DENIED }
  );
  ipcMain.handle('attachment:save', (event, payload) =>
    isTrustedSender(event) ? saveAttachment(payload) : { canceled: true }
  );
}

// 7. 原生菜单与快捷键（Ctrl+N 新对话 / Ctrl+S 导出当前对话 / Ctrl+Shift+L 切换主题 / Ctrl+, 接口设置；
//    窗口无边框不显示菜单栏，但加速键仍然生效；动作统一以 menu:action 通知渲染进程。
function sendMenuAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', action);
  }
}

function buildMenu() {
  const template = [
    {
      label: '对话',
      submenu: [
        { label: '新对话', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
        { label: '导出为 Markdown', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('export-chat') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '设置',
      submenu: [
        { id: 'toggle-theme', label: '切换深浅色主题', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenuAction('toggle-theme') },
        { label: '接口设置', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('open-settings') }
      ]
    },
    // 注册表驱动：新增窗口只要在 app-windows.js 的 WINDOW_DEFS 里写一条含 menu: true，
    // 入口自动出现在这里，主窗口与菜单代码都不需要改
    {
      label: '窗口',
      submenu: Object.entries(WINDOW_DEFS)
        .filter(([, def]) => def && def.menu)
        .map(([view, def]) => ({
          id: `open-window-${view}`,
          label: def.title || view,
          click: () => windowManager.open(view, {})
        }))
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 8. 系统能力：选文件（读成 base64 交渲染进程）与导出保存（文本写文件）
function mimeByFileName(fileName) {
  const ext = path.extname(fileName).replace('.', '').toLowerCase();
  return IMAGE_MIME[ext] || 'application/octet-stream';
}

async function readAttachment(filePath) {
  try {
    // 10MB 的文件读成 base64 约 13MB 字符串，同步读会把主进程事件循环顶住（窗口卡一下）
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_PICK_BYTES) {
      const maxMb = MAX_PICK_BYTES / (1024 * 1024);
      return { error: `文件超过 ${maxMb} MB，请换一个更小的文件` };
    }
    const data = await fs.promises.readFile(filePath);
    return {
      canceled: false,
      name: path.basename(filePath),
      size: stat.size,
      mime: mimeByFileName(filePath),
      base64: data.toString('base64')
    };
  } catch (error) {
    return { error: '文件读取失败，请确认文件未被其它程序占用' };
  }
}

async function pickAttachment() {
  if (IS_SMOKE && SMOKE_OPEN_FILE) {
    const single = await readAttachment(SMOKE_OPEN_FILE);
    return single.error ? single : { canceled: false, files: [single] };
  }
  const dialogOptions = {
    title: '选择要发送的附件（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: PICK_FILTERS
  };
  // 主窗口可能已经销毁：把 null / destroyed 的窗口传给 dialog 会同步抛
  // 「Object has been destroyed」，渲染侧只看到 Promise reject，用户点了没反应
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  const files = [];
  for (const filePath of result.filePaths.slice(0, MAX_PICK_FILES)) {
    const item = await readAttachment(filePath);
    if (item.error) {
      return { canceled: false, error: item.error };
    }
    files.push(item);
  }
  return { canceled: false, files };
}

async function saveMarkdown(options) {
  const opts = options || {};
  const content = String(opts.content == null ? '' : opts.content);
  // 载荷上限：渲染进程传来的内容不可信，超大字符串既吃内存也没意义
  if (content.length > MAX_EXPORT_CHARS) {
    return { canceled: false, error: '内容太长，无法导出（上限 5 MB）' };
  }
  const defaultName = safeFileName(opts.defaultName || '对话导出.md').replace(/\.md$/i, '') + '.md';
  let target = '';
  if (IS_SMOKE && SMOKE_SAVE_PATH) {
    target = SMOKE_SAVE_PATH;
  } else {
    try {
      const saveOptions = {
        title: '导出为 Markdown',
        defaultPath: defaultName,
        filters: [{ name: 'Markdown 文件', extensions: ['md'] }]
      };
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      target = result.filePath;
    } catch (error) {
      return { canceled: false, error: '无法打开保存对话框，请稍后重试' };
    }
  }
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content, 'utf8');
    // 只回文件名：绝对路径留在主进程，别给页面用来拼别的路径
    return { canceled: false, saved: true, name: path.basename(target) };
  } catch (error) {
    return { canceled: false, error: '导出失败，请换一个保存位置后重试' };
  }
}

// 8a. 附件：落临时目录后交系统程序打开 / 另存到用户选的位置。
//     渲染进程永远拿不到、也不需要绝对路径；文件名一律清洗，避免路径穿越与非法字符
const ATTACHMENT_DENIED = '不允许的操作'

function safeFileName(name) {
  const base = path
    .basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim();
  return (base || '附件').slice(0, 120);
}

function attachmentTempDir() {
  return path.join(app.getPath('temp'), 'suixinwenda-attachments');
}

// 临时副本的保留时长：目录里全是「每次打开都写一份」的一次性文件，全仓原本没有任何清理
const TEMP_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

async function cleanupTempAttachments(dir) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (error) {
    return; // 目录还不存在 / 读不了：清理失败不影响打开附件
  }
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const info = await fs.promises.stat(full);
      if (now - info.mtimeMs > TEMP_ATTACHMENT_TTL_MS) {
        await fs.promises.unlink(full);
      }
    } catch (error) {
      // 单个文件删不掉（正被系统程序占用等）不影响本次打开
    }
  }
}

async function writeTempAttachment(payload) {
  const base64 = String((payload && payload.base64) || '');
  if (!base64) {
    return { error: '附件内容为空，无法打开' };
  }
  if (base64.length > MAX_ATTACHMENT_BASE64) {
    return { error: '附件太大，无法打开（上限 30 MB）' };
  }
  const data = Buffer.from(base64, 'base64');
  if (!data.length) {
    return { error: '附件内容为空，无法打开' };
  }
  const dir = attachmentTempDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await cleanupTempAttachments(dir);
  const target = path.join(dir, `${Date.now()}-${safeFileName(payload && payload.name)}`);
  await fs.promises.writeFile(target, data);
  return { path: target };
}

async function openAttachment(payload) {
  // 只放行「本应用支持的附件类型」：`shell.openPath` 对 .exe / .bat / .lnk 就是直接执行，
  // 而 payload 来自渲染进程——一旦页面被注入，这里就是任意程序执行。拒绝的代价只是让用户另存为。
  if (!isOpenableAttachment(payload && payload.name)) {
    return { error: '这类文件不支持用系统程序打开，请先「另存为」保存到本地再打开' };
  }
  const written = await writeTempAttachment(payload);
  if (written.error) {
    return written;
  }
  const failure = await shell.openPath(written.path);
  if (failure) {
    return { error: '系统里没有能打开这个文件的程序，可以先用「另存为」保存到本地' };
  }
  return { opened: true };
}

async function saveAttachment(payload) {
  const opts = payload || {};
  const base64 = String(opts.base64 || '');
  if (!base64) {
    return { canceled: false, error: '附件内容为空，无法保存' };
  }
  if (base64.length > MAX_ATTACHMENT_BASE64) {
    return { canceled: false, error: '附件太大，无法保存（上限 30 MB）' };
  }
  let target = '';
  if (IS_SMOKE && SMOKE_SAVE_PATH) {
    target = SMOKE_SAVE_PATH;
  } else {
    try {
      const saveOptions = { title: '另存附件', defaultPath: safeFileName(opts.name) };
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      target = result.filePath;
    } catch (error) {
      return { canceled: false, error: '无法打开保存对话框，请稍后重试' };
    }
  }
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, Buffer.from(String(opts.base64 || ''), 'base64'));
    return { canceled: false, saved: true, name: path.basename(target) };
  } catch (error) {
    return { canceled: false, error: '保存失败，请换一个位置后重试' };
  }
}

// 8b. 安全加固：外链只交系统浏览器，页面自身不许被导航走。
//     打开前先弹确认：AI 回复里的外链不可信，静默拉起系统浏览器等于替用户点了钓鱼链接
async function openExternalSafely(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      return false;
    }
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['打开链接', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '要用系统浏览器打开这个外部链接吗？',
      detail: parsed.href
    });
    if (!choice || choice.response !== 0) {
      smokeLog(`[SMOKE] external-denied=${parsed.href}`);
      return false;
    }
    shell.openExternal(parsed.href);
    return true;
  } catch (error) {
    return false;
  }
}

function hardenNavigation(win) {
  // 1. 页面里任何 target=_blank / window.open 都拦下来，改由系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  // 2. 主窗口只允许停在当前这份本地页面；指向别处的导航一律阻止
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url === current) {
      return;
    }
    event.preventDefault();
    openExternalSafely(url);
  });
  // 3. 连 window.open 之外的 webview 也不放开
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

// 8c. 启动 / 退出小窗
//     同一个 splash.html 两种模式：boot 收主进程的阶段推送，exit 固定「正在退出…」。
//     小窗只负责「告诉用户现在到哪一步」，任何判定（能不能进主窗口）都留在主进程。

/** 向小窗推一条状态；页面还没加载完就先存着，加载完补发。 */
function notifySplash(phase, message) {
  if (!splashWindow || splashWindow.isDestroyed()) {
    return; // 小窗没建成 / 已关：静默跳过，主窗口的离线态自己会兜
  }
  splashPendingStatus = { phase, message };
  // 阶段也落一行日志：用户说「卡在启动」时，日志能直接看出停在哪个阶段
  logMain('info', `[启动] 阶段=${phase}：${message}`);
  if (splashLoaded) {
    flushSplashStatus();
  }
}

function flushSplashStatus() {
  if (!splashWindow || splashWindow.isDestroyed() || !splashPendingStatus) {
    return;
  }
  splashWindow.webContents.send('splash:status', splashPendingStatus);
  splashPendingStatus = null;
}

// 状态行最多截到这么长：420×300 的小窗换行 3 行就到顶（splash.css 的 -webkit-line-clamp 是 3）
const SPLASH_REASON_MAX = 60;

/**
 * 推给小窗的失败短句。
 *
 * 后端的 error.message 常带「（详见日志：C:\\Users\\...\\backend.log）」这种路径尾巴，
 * 整段塞进 420×300 会把 logo 与底注一起挤掉。这里去掉括号段、压空白、截断，
 * 但**不加省略号**——省略号由 CSS 的 line-clamp 负责，两边都加会出现双省略号。
 * 完整原因仍然进控制台与日志文件。
 */
function shortReason(error) {
  const raw = error && error.message ? error.message : String(error);
  const text = raw
    .replace(/[（(][^（）()]*(日志|log)[^（）()]*[）)]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, SPLASH_REASON_MAX);
}

/**
 * 小窗的放置参数。
 *
 * 给了合法矩形就把它放在该矩形中心：退出小窗沿用主窗口位置，避免「大窗口在副屏/右下角消失、
 * 小窗却从主屏中央冒出来」的一次明显跳变。screen 要求 app 已 ready，显示器也可能中途被拔掉，
 * 所以任何异常都退化成「默认尺寸、交给系统居中」。
 */
function splashPlacement(centerOn) {
  const fallback = { width: SPLASH_WIDTH, height: SPLASH_HEIGHT, x: null, y: null };
  if (
    !centerOn ||
    !Number.isFinite(centerOn.x) ||
    !Number.isFinite(centerOn.y) ||
    !Number.isFinite(centerOn.width) ||
    !Number.isFinite(centerOn.height)
  ) {
    return fallback;
  }
  try {
    const area = screen.getDisplayMatching(centerOn).workArea;
    // 小窗比工作区还大时按工作区收：否则会被挤到屏幕外，用户只看到半根进度线
    const width = Math.min(SPLASH_WIDTH, area.width);
    const height = Math.min(SPLASH_HEIGHT, area.height);
    const x = Math.round(centerOn.x + (centerOn.width - width) / 2);
    const y = Math.round(centerOn.y + (centerOn.height - height) / 2);
    return {
      width,
      height,
      // 位置也要夹：主窗口贴着屏幕边时，按中心算出来的坐标会有一半跑到屏幕外
      x: Math.min(Math.max(x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(y, area.y), area.y + area.height - height)
    };
  } catch (error) {
    return fallback;
  }
}

/**
 * 建一个小窗。失败返回 null 而不是抛：小窗只是提示，
 * 因为「提示显示不出来」而让用户开不了应用是本末倒置。
 */
function createSplash(mode, options = {}) {
  const { centerOn = null } = options;
  const theme = readConfig().theme === 'dark' ? 'dark' : 'light';
  const placement = splashPlacement(centerOn);
  try {
    const win = new BrowserWindow({
      width: placement.width,
      height: placement.height,
      // x/y 用展开传：没有定位需求时不传，交给系统按默认规则摆放
      ...(placement.x === null ? {} : { x: placement.x, y: placement.y }),
      frame: false,
      resizable: false,
      show: false,
      // 首帧底色必须与 splash.css 的 --bg 一致，否则小窗自己会闪一下别的颜色
      backgroundColor: theme === 'dark' ? WINDOW_BG_DARK : WINDOW_BG_LIGHT,
      title: '随心问答',
      icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
      // 两个模式都要占任务栏：boot 阶段主窗口还没 show、不占任务栏，只有小窗能占，
      // 否则启动那几秒任务栏是空的，用户会以为没启动再双击一次；
      // exit 阶段继续占，是为了任务栏图标从启动一路延续到进程真正结束
      skipTaskbar: false,
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) {
        return;
      }
      win.show();
      // 计时从「窗口真的显示出来」之后开始：show() 本身要花十几毫秒，
      // 计在它前面会让最短展示时长少一截，日志里两行时间也对不上账
      splashShownAt = Date.now();
      logMain('info', `[启动] 小窗已显示（${Date.now() - BOOT_STARTED_AT}ms，mode=${mode}）`);
    });
    win.webContents.once('did-finish-load', () => {
      splashLoaded = true;
      flushSplashStatus();
    });
    win.on('closed', () => {
      if (splashWindow === win) {
        splashWindow = null;
        splashLoaded = false;
        splashPendingStatus = null;
        splashShownAt = 0;
      }
    });
    // 加载失败时不会有 ready-to-show，小窗就一直白着不显示，主窗口只能等后端超时。
    // 这是「小窗关闭必须挂在 showWindow 内」的显式例外：失败路径允许先 destroy 再放行，
    // 验收时「小窗已销毁」与「主窗口已显示」各有一条日志
    win.loadFile(path.join(__dirname, 'renderer', 'splash.html'), { query: { mode, theme } }).catch((error) => {
      logMain('error', '[启动] 小窗页面加载失败，直接放行主窗口', error);
      if (splashWindow === win) {
        splashWindow = null;
      }
      // 清干净状态，避免 closeSplash 二次 destroy 已经没了的窗口
      splashShownAt = 0;
      splashLoaded = false;
      splashPendingStatus = null;
      if (!win.isDestroyed()) {
        win.destroy();
        logMain('info', '[启动] 小窗已销毁（加载失败）');
      }
      forceShowWindow('splash-load-failed');
    });
    return win;
  } catch (error) {
    logMain('error', '[启动] 小窗创建失败，直接显示主窗口', error);
    return null;
  }
}

/**
 * 关小窗。
 *
 * 补时只在调用方显式给出 minDwellMs 时生效：启动成功路径的等待已经挪到 showWindow 里
 * （等的是「显示主窗口」而不是「关闭小窗」），这里再补一遍就会多等一次；
 * 退出路径则必须补，否则 stop() 一快小窗就被 destroy 掉，用户看不到「正在退出」。
 */
async function closeSplash({ minDwellMs = 0 } = {}) {
  const win = splashWindow;
  if (!win || win.isDestroyed()) {
    splashWindow = null;
    return;
  }
  if (minDwellMs > 0 && splashShownAt) {
    const elapsed = Date.now() - splashShownAt;
    if (elapsed < minDwellMs) {
      await wait(minDwellMs - elapsed);
    }
  }
  try {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  } catch (error) {
    console.error('[小窗] 关闭失败', error);
  }
  splashWindow = null;
  splashLoaded = false;
  splashPendingStatus = null;
  splashShownAt = 0;
}

/** 退出中窗口：启动没走完就退出时，先把 boot 小窗换掉再显示「正在退出」。 */
function showExitSplash() {
  if (IS_SMOKE) {
    return; // 冒烟进程退出不能弹窗，否则自检收尾会被窗口事件干扰
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
  splashLoaded = false;
  splashPendingStatus = null;
  splashShownAt = 0;
  // 用主窗口关闭前的常规边界做中心：小窗就该出现在大窗口刚消失的地方
  splashWindow = createSplash('exit', { centerOn: lastMainBounds });
}

/**
 * 主窗口的「后端已就绪」通知。
 *
 * 主窗口可能先加载完、后端后才就绪；没有这条事件，用户要多等 5 秒离线轮询
 * 才看到「已连接」，明明已经能用了却显示连不上。
 */
function notifyBackendReady() {
  backendReadyFlag = true;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.webContents.isLoading()) {
    return; // 页面加载完后在 did-finish-load 里补发
  }
  mainWindow.webContents.send('backend:ready');
}

/** 启动超时兜底：把闸门打开让主窗口出来，绝不把用户留在小窗。 */
function forceShowWindow(reason) {
  if (showGate) {
    return; // 正常流程已经放行
  }
  logMain('warn', `[启动] 兜底放行主窗口（${reason}）：界面进入离线态，可点重试`);
  showGate = true;
  showWindow(reason, { skipMinDwell: true });
}

// 9. 创建主窗口
function createWindow() {
  const sizeOverride = IS_SMOKE ? parseSmokeSize() : null;
  // 底色跟随上次保存的主题：深色主题下用浅色打底会出现明显的白闪
  const startupBg = readConfig().theme === 'dark' ? WINDOW_BG_DARK : WINDOW_BG_LIGHT;
  mainWindow = new BrowserWindow({
    width: sizeOverride ? sizeOverride.width : WINDOW_WIDTH,
    height: sizeOverride ? sizeOverride.height : WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    frame: false,
    show: false,
    backgroundColor: startupBg,
    title: '随心问答',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // 9b. 导航与新窗口拦截：页面只允许停在本地 index.html，
  //     链接一律交给系统浏览器打开，避免远端页面加载后拿到 desktopBridge 的 IPC 能力
  hardenNavigation(mainWindow);

  // 9c. IPC 来源白名单的基准路径：入口页自己的绝对路径（见 isTrustedSender）
  entryFilePath = path.resolve(path.join(__dirname, 'renderer', 'index.html'));

  // 9d. 权限请求一律拒绝，只放行「复制时写剪贴板」这一项。
  //     Electron 未注册 handler 时对权限请求默认放行，一旦页面被注入就能静默申请
  //     通知 / 麦克风 / 剪贴板读取；本项目只用得到 navigator.clipboard.writeText。
  //     request 与 check 两个入口口径必须一致，只注册一个等于留了个后门。
  {
    const session = mainWindow.webContents.session;
    const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
    session.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    session.setPermissionCheckHandler((webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
  }

  // 10. 显示三重兜底：ready-to-show → did-finish-load → 超时
  mainWindow.once('ready-to-show', () => showWindow('ready-to-show'));
  mainWindow.webContents.once('did-finish-load', () => {
    showWindow('did-finish-load');
    // 后端可能比页面先就绪：这里补发一次，页面才不会白等 5 秒的离线轮询
    if (backendReadyFlag && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend:ready');
    }
    if (IS_SMOKE) {
      pendingTimers.push(setTimeout(() => runSmokeSafely(), SMOKE_HOLD_MS));
    }
  });
  pendingTimers.push(setTimeout(() => showWindow('timeout'), SHOW_FALLBACK_MS));
  if (IS_SMOKE) {
    pendingTimers.push(setTimeout(() => runSmokeSafely(), SHOW_FALLBACK_MS + SMOKE_HOLD_MS));
  }

  // 11. 渲染进程报错计数（自检判据：控制台无报错）
  mainWindow.webContents.on('console-message', (event, level, message) => {
    const newForm = event && typeof event.level === 'string';
    const levelValue = newForm ? event.level : level;
    const messageText = newForm ? event.message : message;
    if (levelValue === 'error' || levelValue === 3) {
      rendererErrorCount += 1;
      smokeLog(`[SMOKE] console-error=${messageText}`);
    }
  });
  mainWindow.webContents.on('did-fail-load', (event, code, description) => {
    rendererErrorCount += 1;
    smokeLog(`[SMOKE] load-fail=${code} ${description}`);
  });
  // 11b. 渲染进程崩溃兜底：崩溃后只剩白屏最难排查，这里打中文日志并自动重载一次。
  //      只重载一次：页面一加载就崩时会无限重载刷屏；冒烟不重载，否则断言结论不可信
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`[渲染进程] 已退出：${details.reason}`);
    smokeLog(`[SMOKE] render-gone=${details.reason}`);
    if (IS_SMOKE || Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) {
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      lastReloadAt = Date.now();
      mainWindow.reload();
    }
  });

  // 12. 最大化状态变化广播给渲染进程（标题栏按钮样式跟随）
  ['maximize', 'unmaximize'].forEach((eventName) => {
    mainWindow.on(eventName, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
      }
    });
  });

  // 12a. 点 × / Alt+F4 / 菜单退出一律走 beginShutdown()：
  //      主窗口先藏起来、换成「正在退出」小窗，进程真正收完后才消失。
  //      外部启动的后端不归本应用关，窗口直接关掉即可。
  mainWindow.on('close', (event) => {
    // 位置快照要在 preventDefault 之前取：等到 beginShutdown 里窗口可能已经没了。
    // 用 getNormalBounds 而不是 getBounds：最大化时后者是整屏范围，退出小窗会被放到整屏中心
    if (mainWindow && !mainWindow.isDestroyed()) {
      lastMainBounds = mainWindow.getNormalBounds();
    }
    // 恢复的 stop()→start() 之间 ownsProcess() 是 false，正好落在下面那个「直接放行」分支里；
    // 不单独拦一下，用户点 × 就能让 Electron 退出、恢复子进程继续写库
    if (busyMessage()) {
      event.preventDefault();
      warnBusy();
      return;
    }
    if (!backendManager.ownsProcess()) {
      return;
    }
    event.preventDefault();
    beginShutdown();
  });

  // 12b. 窗口关闭时清掉挂起的定时器，避免退出过程中回调再碰已销毁的窗口
  mainWindow.on('closed', () => {
    pendingTimers.forEach((timer) => clearTimeout(timer));
    pendingTimers.length = 0;
    mainWindow = null;
    // 启动阶段主窗口被系统关掉（Alt+F4 连击、任务管理器结束任务）时还没有任何退出流程：
    // 不管的话进程会变成「没有窗口但还在跑」的僵尸，后端也一直占着端口
    if (bootstrapping && !shuttingDown) {
      logMain('warn', '[启动] 主窗口在启动阶段被关闭，直接退出');
      beginShutdown();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: IS_SMOKE ? buildSmokeQuery() : {}
  });
}

async function showWindow(reason, { skipMinDwell = false } = {}) {
  // 闸门没开就什么都不做：启动阶段 ready-to-show 会先到，不能让它把主窗口提前弹出来。
  // showPending / isVisible 两条是防重入：showWindow 有四个入口，补时期间主窗口还不可见
  if (!showGate || showPending) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) {
    return;
  }
  showPending = true;
  try {
    // 延后的是「显示」，不是「关闭」：小窗还没展示够最短时长就先等着，
    // 避免复用外部后端时主窗口 290ms 就弹出来、两个窗口叠在一起
    const raw = splashShownAt ? Date.now() - splashShownAt : 0;
    const remain = skipMinDwell ? 0 : Math.max(0, Math.min(SPLASH_MIN_MS - raw, SPLASH_MIN_MS));
    if (remain > 0) {
      await wait(remain);
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.show();
    // 必须放在 show 之后：提前置 false 会在等待的几百毫秒里留下
    // 「零可见窗口 + 退出守卫失效」的洞
    bootstrapping = false;
    shownBy = reason;
    smokeLog(`[SMOKE] show=${reason}`);
    if (!IS_SMOKE) {
      logMain('info', `[启动] 主窗口已显示（${Date.now() - BOOT_STARTED_AT}ms，${reason}）`);
    }
  } finally {
    showPending = false;
  }
  // 顺序不能反：先显示主窗口再关小窗，反了会露出 0.3~0.5 秒的空白帧
  await closeSplash();
}

/** 只负责等主窗口页面就绪，不负责显示（显示只走 showWindow）。 */
function waitMainWindowReady() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve('no-window');
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (reason) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    timer = setTimeout(() => finish('timeout'), SHOW_FALLBACK_MS);
    mainWindow.once('ready-to-show', () => finish('ready-to-show'));
    mainWindow.webContents.once('did-finish-load', () => finish('did-finish-load'));
    // 极快的情况下页面可能已经加载完，事件不会再来了
    if (!mainWindow.webContents.isLoading()) {
      finish('already-loaded');
    }
  });
}

// 13. 冒烟自检：窗口已显示 + 渲染进程无报错 + 安全隔离生效 + 尺寸合规 + 窗口控制可用 + 截图
// 等渲染进程场景入口就绪（`window.__smokeScenario` 挂上）再注入按键，避免页面还在初始化时注入丢失
async function waitForScenarioReady(limit = 30) {
  for (let i = 0; i < limit; i += 1) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return false;
    }
    try {
      const ready = await mainWindow.webContents.executeJavaScript('typeof window.__smokeScenario === "function"');
      if (ready) {
        return true;
      }
    } catch (error) {
      // 页面尚未就绪，继续下一轮等待
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function captureShot() {
  if (!SMOKE_SHOT) {
    return true;
  }
  try {
    const image = await mainWindow.webContents.capturePage();
    await fs.promises.mkdir(path.dirname(SMOKE_SHOT), { recursive: true });
    await fs.promises.writeFile(SMOKE_SHOT, image.toPNG());
    smokeLog(`[SMOKE] shot=${SMOKE_SHOT}`);
    return true;
  } catch (error) {
    smokeLog(`[SMOKE] shot-error=${error.message}`);
    return false;
  }
}

async function runSmokeChecks() {
  if (smokeFinished) {
    return;
  }
  smokeFinished = true;

  const probe = await mainWindow.webContents.executeJavaScript(
    '({ bridge: typeof window.desktopBridge, nodeRequire: typeof window.require, nodeProcess: typeof window.process })'
  );
  smokeLog(`[SMOKE] probe bridge=${probe.bridge} require=${probe.nodeRequire} process=${probe.nodeProcess}`);

  const pageReport = await mainWindow.webContents.executeJavaScript(
    'typeof window.__smokeReport === "function" ? window.__smokeReport() : null'
  );
  if (pageReport) {
    smokeLog(
      `[SMOKE] page=theme:${pageReport.theme} sidebar:${pageReport.sidebarWidth} titlebar:${pageReport.titlebarHeight} failures:${
        pageReport.failures.length ? pageReport.failures.join('|') : 'none'
      }`
    );
  }

  // 场景自检（SMOKE_SCENARIO 取值清单唯一源；实现见 renderer/app.js 段落 15）
  let scenarioOk = true;
  if (SMOKE_SCENARIO) {
    scenarioOk = false;
    if (SMOKE_SCENARIO === 'enhance') {
      // 菜单链路一：主进程直接发一次菜单动作（验证菜单 → preload → 渲染进程）；
      // 菜单链路二：等窗口聚焦就绪后触发一次菜单项 Ctrl+Shift+L（验证原生菜单加速键确实生效），页面在场景内断言两次主题变化
      // 加固：先等到 did-finish-load 之后再触发；未就绪时菜单项点击不会落到页面上
      await waitForScenarioReady();
      sendMenuAction('toggle-theme');
      pendingTimers.push(setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return;
        }
        // 加速键链路二：菜单项必须声明 Ctrl+Shift+L（断言 accelerator 存在），再触发该菜单项；
        // 不再用 webContents.sendInputEvent —— 它不保证回落到原生菜单加速键，留着会得到假 FAIL
        const menu = Menu.getApplicationMenu();
        const item = menu ? menu.getMenuItemById('toggle-theme') : null;
        const declared = item ? String(item.accelerator || '') : '';
        smokeLog(`[SMOKE] accelerator-declared=${declared}`);
        if (item && declared === 'CmdOrCtrl+Shift+L') {
          item.click();
        }
      }, 1800));
    }
    try {
      const report = await mainWindow.webContents.executeJavaScript(
        `window.__smokeScenario(${JSON.stringify(SMOKE_SCENARIO)})`
      );
      const failures = report && report.failures ? report.failures : ['scenario-report-missing'];
      scenarioOk = failures.length === 0;
      smokeLog(`[SMOKE] scenario=${SMOKE_SCENARIO} failures=${failures.length ? failures.join('|') : 'none'}`);
    } catch (error) {
      smokeLog(`[SMOKE] scenario=${SMOKE_SCENARIO} failures=run-error:${error && error.message}`);
    }
  }

  // 独立窗口自检：每扇窗都必须真的把视图挂进 #aw-root，
  // 否则「窗口开了但内容是空白」这种失败在页面侧完全看不出来。
  // 末开的窗口可能还在加载，给 3 秒轮询窗口，避免把「慢」误判成「空」。
  const childWindows = windowManager.listWindows();
  const childFailures = [];
  let mainTheme = '';
  try {
    mainTheme = await mainWindow.webContents.executeJavaScript('document.documentElement.dataset.theme');
  } catch (error) {
    mainTheme = '';
  }
  for (const item of childWindows) {
    if (!item.webContents || item.webContents.isDestroyed()) {
      childFailures.push(`${item.view}:destroyed`);
      continue;
    }
    let mounted = false;
    for (let attempt = 0; attempt < 30 && !mounted; attempt += 1) {
      if (item.webContents.isDestroyed()) {
        break;
      }
      try {
        mounted = await item.webContents.executeJavaScript(
          'Boolean(document.querySelector("#aw-root") && document.querySelector("#aw-root").childElementCount > 0)'
        );
      } catch (error) {
        mounted = false; // 页面还没加载完，继续等
      }
      if (!mounted) {
        await wait(100);
      }
    }
    if (!mounted) {
      childFailures.push(`${item.view}:empty`);
      continue;
    }
    // 主题必须跟主窗口一致：窗口是多份 JS 运行时，主题只靠广播同步，最容易漏掉
    if (mainTheme) {
      try {
        const theme = await item.webContents.executeJavaScript('document.documentElement.dataset.theme');
        if (theme !== mainTheme) {
          childFailures.push(`${item.view}:theme=${theme}`);
        }
      } catch (error) {
        childFailures.push(`${item.view}:theme-error`);
      }
    }
  }
  if (childWindows.length) {
    smokeLog(
      `[SMOKE] child-windows=${childWindows.length} failures=${childFailures.length ? childFailures.join('|') : 'none'}`
    );
  }
  const childrenOk = childFailures.length === 0;

  const bounds = mainWindow.getBounds();
  const content = mainWindow.getContentSize();
  const minSize = mainWindow.getMinimumSize();
  smokeLog(
    `[SMOKE] bounds=${bounds.width}x${bounds.height} content=${content[0]}x${content[1]} min=${minSize[0]}x${minSize[1]}`
  );

  mainWindow.maximize();
  await wait(400);
  const maximized = mainWindow.isMaximized();
  mainWindow.unmaximize();
  await wait(400);
  const restored = !mainWindow.isMaximized();
  smokeLog(`[SMOKE] maximize=${maximized} restore=${restored}`);

  const shotOk = await captureShot();

  const pageOk = pageReport ? pageReport.failures.length === 0 : true;
  const pass =
    shownBy !== '' &&
    rendererErrorCount === 0 &&
    pageOk === true &&
    scenarioOk === true &&
    childrenOk === true &&
    probe.bridge === 'object' &&
    probe.nodeRequire === 'undefined' &&
    probe.nodeProcess === 'undefined' &&
    maximized === true &&
    restored === true &&
    shotOk === true;
  smokeLog(`[SMOKE] shown-by=${shownBy || 'none'} renderer-errors=${rendererErrorCount}`);
  smokeLog(pass ? '[SMOKE] PASS' : '[SMOKE] FAIL');
  cleanupSmokeUserData();
  app.exit(pass ? 0 : 1);
}

// 冒烟退出前尽力删掉临时 userData；Chromium 还占着句柄时删不掉属正常，下次启动会再清
function cleanupSmokeUserData() {
  if (!SMOKE_USER_DATA) {
    return;
  }
  try {
    fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true });
  } catch (error) {
    // 忽略：不影响自检结论
  }
}

function runSmokeSafely() {
  runSmokeChecks().catch((error) => {
    smokeLog(`[SMOKE] error=${error && error.message}`);
    smokeLog('[SMOKE] FAIL');
    cleanupSmokeUserData();
    app.exit(2);
  });
}

// 13b. 后端托管：起不来只记日志——界面上的离线横幅与重试按钮本来就是兜这个场景的
//      小窗文案只按真实阶段推进，不编中间态（编了就会在真卡住时给出错误安抚）
async function startBackendIfNeeded() {
  // 冒烟由外部 mock-server 提供后端并提供固定数据；托管会抢 8010，断言也会失真
  if (IS_SMOKE) {
    return false;
  }
  notifySplash('spawning', '正在启动本地服务…');
  try {
    backendManager.ensureEnvFile();
    // 模型配置：先写运行时明文文件，后端启动时才读得到（文件不存在则回退 .env）
    try {
      const payload = syncRuntimeModels();
      logMain('info', `[模型] 已同步 ${payload.models.length} 个模型到后端`);
    } catch (error) {
      logMain('warn', `[模型] 同步失败（后端将回退到 .env）：${error.message}`);
    }
    const stale = await backendManager.cleanupStale();
    if (stale.action === 'reused') {
      logMain('info', '[后端] 复用已在运行的外部后端（退出时不接管）');
      notifyBackendReady();
      return true;
    }
    if (stale.action === 'killed') {
      logMain('warn', `[后端] 已清理上次崩溃留下的进程（pid=${stale.pid}）`);
    }
    // 紧接着 start() 就是 spawn + 健康轮询：用户看到的等待时间全在这里
    notifySplash('waiting', '正在等待服务响应…');
    await backendManager.start();
    logMain('info', `[后端] 已启动，日志：${backendManager.logPath()}`);
    notifyBackendReady();
    return true;
  } catch (error) {
    // 只取 message：完整堆栈又长又看不懂，塞进小窗只会盖住那一行字
    const reason = (error && error.message) || String(error);
    // 完整原因进控制台与日志文件，小窗只拿截断后的短句（见 shortReason）
    logMain('error', `[后端] 启动失败：${reason}`);
    notifySplash('failed', `本地服务启动失败：${shortReason(error)}`);
    // 红字停够 1.2 秒再放行主窗口，否则用户只看到一闪而过的报错
    await wait(SPLASH_FAIL_DWELL_MS);
    return false;
  }
}

/**
 * 唯一的退出入口：点 × / Alt+F4 / 菜单退出 / before-quit 全部汇到这里。
 *
 * 为什么必须单入口：两套逻辑并存时「谁先 preventDefault」随手势不同而不同，
 * 表现成有时留下孤儿进程、有时窗口先没了进程还在。
 */
async function beginShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const startedAt = Date.now();
  // 兜底：小窗显示不出来、stop() 卡住时也必须退，不能因为「提示不了」而卡死。
  // 这条路径不经过别的日志点，所以自己写一行：否则日志会停在「正在停止本地服务…」，
  // 看不出到底是卡住还是超时兜底
  const hardExit = setTimeout(() => {
    logMain('warn', '[退出] 兜底超时，强制退出');
    // 兜底路径也必须删运行时模型文件：里面是明文 API Key，留在磁盘上等于长期泄露
    try {
      backendManager.removeRuntimeModels();
    } catch (error) {
      logMain('warn', '[退出] 清理运行时模型文件失败（已忽略）', error);
    }
    app.exit(0);
  }, SHUTDOWN_MAX_MS);
  logMain('info', '[退出] 正在停止本地服务…');
  try {
    // 子窗口先收：主窗口一藏，任务栏就只剩小窗，桌面上不该留一堆无主窗口
    windowManager.closeAll();
    showExitSplash();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    await backendManager.stop(); // 自带 2.5 秒优雅 + 1.5 秒 taskkill
  } catch (error) {
    logMain('error', '[退出] 停止后端失败，直接退出', error);
  } finally {
    clearTimeout(hardExit);
    // 先销毁小窗再 exit：反过来会残留一个空窗口。
    // 退出小窗要补足最短展示，否则 stop() 极快时它在 ready-to-show 前就被 destroy
    await closeSplash({ minDwellMs: EXIT_SPLASH_MIN_MS });
    // 关键：这里必须显式删运行时模型文件。它原本只挂在 will-quit 上，
    // 而下面直接调 app.exit(0) 不会触发 will-quit —— 每次正常退出都把明文 Key 留在磁盘上
    try {
      backendManager.removeRuntimeModels();
    } catch (error) {
      logMain('warn', '[退出] 清理运行时模型文件失败（已忽略）', error);
    }
    logMain('info', `[退出] 已停止本地服务（${Date.now() - startedAt}ms）`);
    app.exit(0);
  }
}

// 14. 应用生命周期
// 冒烟模式不参与单实例锁：正式应用开着时也能跑自检（两边 userData 已隔离）
const hasSingleInstanceLock = IS_SMOKE ? true : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 启动阶段主窗口还藏着：先让小窗冒头，否则再点一次图标会觉得「没反应」
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show();
      splashWindow.focus();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 必须在建窗口前设置：Windows 任务栏按 AppUserModelID 归组，缺省会用 electron.exe 的默认图标
  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.whenReady().then(async () => {
    // 上一次进程被强杀 / 崩溃 / 断电时走不到退出清理，userData/runtime 里可能留着明文 API Key。
    // 必须在 syncRuntimeModels() 重建之前清一次：本进程随后会按最新配置重新写。
    // 放在单实例锁之后：第二个实例不会走到这里，不会删掉正在运行的那个实例的文件。
    try {
      backendManager.removeRuntimeModels();
    } catch (error) {
      logMain('warn', '[启动] 清理上次残留的运行时模型文件失败（已忽略）', error);
    }
    // 先把配置读进内存缓存再建窗口：createWindow() 是同步路径，要用主题定首帧底色
    await loadConfig();
    buildMenu();
    registerIpc();
    // 非冒烟时先关掉显示闸门，否则 ready-to-show 一放就显示，启动小窗等于白做
    showGate = IS_SMOKE;
    bootstrapping = true;
    if (!IS_SMOKE) {
      splashWindow = createSplash('boot');
      if (!splashWindow) {
        // 小窗都建不出来（极少见）：退回原流程，让主窗口自己显示，别把用户卡在黑屏
        logMain('warn', '[启动] 小窗创建失败，直接显示主窗口');
        showGate = true;
      }
      // 总兜底：后端再慢也不能让主窗口永不出现。
      // 不变式：兜底必须 ≥ 就绪超时 × 1.4（30s→45s、60s→90s），否则失败提示还没停够就被兜底抢掉；
      // 打包版的就绪超时是 60s，用 32s 兜底等于后端还在正常重试就把窗口提前放出来
      pendingTimers.push(
        setTimeout(
          () => forceShowWindow('boot-timeout'),
          app.isPackaged ? BOOT_MAX_MS_PACKAGED : BOOT_MAX_MS
        )
      );
    }
    // 主窗口立即创建（show:false 只是加载页面），与后端启动并行：
    // 串起来就是「等 3.5 秒后端 + 再等 0.4 秒页面」。
    // 建不出来就不该继续往下走：没有主窗口的启动链最后只会变成「进程在跑、界面没有」
    try {
      createWindow();
    } catch (error) {
      logMain('error', '[启动] 主窗口创建失败', error);
      await closeSplash();
      app.exit(1);
      return;
    }
    if (IS_DEV && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    const [, backendReady] = await Promise.all([waitMainWindowReady(), startBackendIfNeeded()]);
    if (!IS_SMOKE) {
      // 页面与后端都好了：先显示主窗口再关小窗，用户看不到任何空白帧
      showGate = true;
      // 后端没起来时日志里必须看得出来：原先一律写 backend-ready，
      // 事后排查「为什么打包版一直离线」会先被这行误导
      await showWindow(backendReady ? 'backend-ready' : 'backend-failed');
      // 定期自动备份放在窗口显示之后：备份要扫库、打包附件，放在显示之前会拖慢启动。
      // 后端没起来时不跑（备份工具要读库，跑了也只会得到一条失败日志）
      if (backendReady) {
        autoBackupIfDue().catch((error) => logMain('warn', '[自动备份] 检查失败', error));
      }
    }
  }).catch(async (error) => {
    // 初始化链没有兜底时，出错的表现是「进程在跑、窗口不出来、日志里什么都没有」
    logMain('error', '[启动] 桌面端初始化失败', error);
    // 小窗必须比进程先消失：反了会留一个「正在启动」的残窗在桌面上
    await closeSplash();
    app.exit(1);
  });

  // 退出前必须把托管的子进程收掉：否则强杀 / 崩溃会留下占着 8010 的孤儿进程。
  // 与窗口 close 共用 beginShutdown()：两套逻辑并存迟早有一边漏关
  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return; // beginShutdown 自己在最后 app.exit
    }
    if (busyMessage()) {
      // 工具子进程还在写库：此刻退出会留下一份写了一半的数据
      event.preventDefault();
      warnBusy();
      return;
    }
    if (!backendManager.ownsProcess()) {
      return; // 外部启动的后端不归本应用管，退出时不要动它
    }
    event.preventDefault();
    beginShutdown();
  });

  // 运行时模型文件里有明文 Key：退出时删掉（删不掉也不拦退出）
  app.on('will-quit', () => backendManager.removeRuntimeModels());

  app.on('window-all-closed', () => {
    // 启动阶段小窗被关掉不代表要退出：主窗口还在后台加载，等它出来再说
    if (bootstrapping) {
      return;
    }
    app.quit();
  });
}
