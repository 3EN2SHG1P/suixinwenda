/**
 * 文件：desktop/src/app-windows.js
 * 职责：应用内「独立子窗口」的工厂与注册表——创建 / 复用 / 位置记忆 / 夹屏 / 置顶 / 统一广播；
 *      对外只暴露窗口键名与少量开关，新增窗口只改 WINDOW_DEFS，不碰 z-index、不碰焦点栈。
 *
 * 口径：
 *  1. 子窗口一律 parent = 主窗口（Windows 上天然盖在父窗口之上、父窗口最小化时一起收起），
 *     但不设 modal：主窗口保持可交互，这就是「不遮挡」的实现方式。
 *  2. 跨软件置顶只由用户点标题栏图钉开启（默认不置顶），否则设置窗口会浮在微信上。
 *  3. 位置与尺寸落在 userData/window-bounds.json，独立于 config.json 的白名单（渲染进程改不到）。
 *  4. 不 require('electron')：BrowserWindow / ipcMain / screen 全部由 main.js 注入，便于单测。
 */
'use strict';

const path = require('path');
const fs = require('fs');

// 窗口注册表：新增窗口只加一条
// title 供自绘标题栏与任务栏共用；memory = 记住位置与尺寸；singleton = 同一时间只允许一个
const WINDOW_DEFS = {
  settings: { title: '设置', width: 800, height: 600, minWidth: 720, minHeight: 520, resizable: true, memory: true },
  // 高度不再取 720：主窗口默认就是 1180×720，同高会让这扇窗一打开就顶天立地、
  // 把父窗口的标题栏与输入坞各切掉一截，看起来像「整块面板」而不是浮窗
  memory: { title: '对话历史', width: 640, height: 620, minWidth: 480, minHeight: 400, resizable: true, memory: true },
  // 预览与灯箱允许多开：同时对照两份文档是真实需求，不做单例就不会被后来的那份顶掉
  preview: {
    title: '文件预览',
    width: 760,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    resizable: true,
    memory: true,
    singleton: false
  },
  lightbox: {
    title: '图片预览',
    width: 900,
    height: 700,
    minWidth: 380,
    minHeight: 300,
    resizable: true,
    memory: true,
    singleton: false
  },
  auth: { title: '登录随心问答', width: 448, height: 596, minWidth: 448, minHeight: 560, resizable: false, memory: true },
  // 表单类窗口一律允许多开：「设置里删除产物」与「主窗口删除会话」可能同时存在两份确认，
  // 复用同一扇窗会让后一份载荷顶掉前一份，确认结果回错人。
  nickname: {
    title: '修改昵称',
    width: 360,
    height: 232,
    minWidth: 360,
    minHeight: 232,
    resizable: false,
    // 一律记住位置：第一次落在主窗口中心，用户挪过之后就回原位
    memory: true,
    singleton: false
  },
  model: { title: '模型', width: 520, height: 660, minWidth: 480, minHeight: 480, resizable: true, memory: true, singleton: false },
  prompt: {
    title: '提示词库',
    width: 640,
    height: 560,
    minWidth: 480,
    minHeight: 360,
    resizable: true,
    memory: true,
    singleton: true,
    menu: true
  },
  storage: {
    title: '切换存储',
    width: 520,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    resizable: true,
    memory: true,
    singleton: false
  },
  save: { title: '保存', width: 448, height: 420, minWidth: 448, minHeight: 300, resizable: false, memory: true, singleton: false },
  restore: {
    title: '从备份恢复',
    width: 448,
    height: 520,
    minWidth: 448,
    minHeight: 320,
    resizable: false,
    memory: true,
    singleton: false
  },
  confirm: { title: '请确认', width: 448, height: 220, minWidth: 448, minHeight: 200, resizable: false, memory: true, singleton: false },
  rename: {
    title: '重命名会话',
    width: 448,
    height: 208,
    minWidth: 448,
    minHeight: 208,
    resizable: false,
    memory: true,
    singleton: false
  }
};

// 判定「还记得住的位置」：至少要在某块屏幕里露出这么一块可点区域，否则等于窗口丢了
const MIN_VISIBLE_X = 120;
const MIN_VISIBLE_Y = 48;
const STATE_FILE = 'window-bounds.json';
const MAX_SIDE = 8000;

function clampNumber(value, min, max, fallback) {
  // null / undefined / 空串必须当成「没值」走 fallback：Number(null) 和 Number('') 都是 0，
  // 会被下面的 isFinite 放行，于是 Math.max(min, 0) 直接把窗口夹到最小尺寸。
  // 表现是「所有子窗口第一次打开都挤在 minWidth×minHeight」，只有手动拉大过一次才记住。
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * 窗口管理器。
 *
 * @param {object} deps
 * @param {Function} deps.BrowserWindow electron 的 BrowserWindow 构造器
 * @param {object} deps.app electron app
 * @param {object} deps.ipcMain electron ipcMain
 * @param {object} deps.screen electron screen
 * @param {string} deps.rendererDir 渲染进程目录（app-window.html 所在目录）
 * @param {string} deps.preloadPath 子窗口 preload 绝对路径
 * @param {string} deps.iconPath 任务栏/标题图标（不存在时留空）
 * @param {Function} deps.getTheme 返回 'light' | 'dark'
 * @param {Function} deps.getMainWindow 返回当前主窗口（可能为 null）
 * @param {Function} [deps.onWindowCreated] 建好后的钩子（主进程用它套导航/权限加固）
 * @param {Function} [deps.onResult] 子窗口回传结果的出口（主进程转发给主窗口）
 * @param {Function} [deps.onClosed] 子窗口未回结果就关掉的出口（主窗口据此解除挂起）
 * @param {Function} [deps.isTrustedSender] 复用主进程的来源校验
 * @param {Function} [deps.log] 日志出口
 */
function createWindowManager(deps) {
  const {
    BrowserWindow,
    app,
    ipcMain,
    screen,
    rendererDir,
    preloadPath,
    iconPath,
    getTheme,
    getMainWindow,
    onWindowCreated,
    onResult,
    onClosed,
    log
  } = deps;

  const windows = new Map(); // key -> BrowserWindow
  // 正在整批销毁（退出流程的 closeAll）：此时不要回焦主窗口，否则会抢一帧前台再把窗口藏起来
  let closingAll = false;
  const payloads = new Map(); // webContents.id -> 初始载荷
  const entries = new Map(); // webContents.id -> 该窗口的入口文件绝对路径
  const openers = new Map(); // webContents.id -> 打开它的那扇窗的 webContents.id（0 = 主窗口）
  let boundsCache = null;
  let seq = 0;
  let ipcReady = false;

  function note(level, text, detail) {
    if (typeof log === 'function') {
      log(level, text, detail);
    }
  }

  function statePath() {
    return path.join(app.getPath('userData'), STATE_FILE);
  }

  function readBounds() {
    if (boundsCache) {
      return boundsCache;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      boundsCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (error) {
      boundsCache = {};
    }
    return boundsCache;
  }

  /** 写位置快照：串行写、失败只记日志（记不住位置不影响本次使用）。 */
  let saveChain = Promise.resolve();
  function persistBounds(key, win) {
    const def = WINDOW_DEFS[key.split('#')[0]];
    if (!def || !def.memory || !win || win.isDestroyed()) {
      return;
    }
    const box = win.getNormalBounds();
    readBounds()[key] = { x: box.x, y: box.y, width: box.width, height: box.height };
    // 多开窗口（preview#12 这类）会不断产生新键：只留最近 8 个，否则快照文件只增不减
    const prefix = `${key.split('#')[0]}#`;
    if (key.includes('#')) {
      const siblings = Object.keys(boundsCache)
        .filter((name) => name.startsWith(prefix))
        .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
      siblings.slice(0, Math.max(0, siblings.length - 8)).forEach((name) => {
        delete boundsCache[name];
      });
    }
    const snapshot = JSON.stringify(boundsCache, null, 2);
    const file = statePath();
    // 先写临时文件再原子替换：直接覆盖时进程被强杀会留下截断的 JSON，
    // 下次启动 readBounds 只能静默降级成 {}，用户所有窗口位置一次性清零
    saveChain = saveChain
      .then(() => fs.promises.mkdir(path.dirname(file), { recursive: true }))
      .then(() => fs.promises.writeFile(`${file}.tmp`, snapshot, 'utf8'))
      .then(() => fs.promises.rename(`${file}.tmp`, file))
      .catch((error) => note('warn', `[窗口] 位置快照写入失败：${error.message}`));
  }

  /** 主窗口中心（主窗口不可见时用主屏中心）：新窗口默认出现在用户正在看的地方。 */
  function centerBox(width, height) {
    const main = getMainWindow();
    let area = null;
    if (main && !main.isDestroyed()) {
      const box = main.getBounds();
      area = screen.getDisplayMatching(box).workArea;
      if (area) {
        // 窗口比主窗口还大时要先收进工作区，否则 x/y 会被夹成负数
        const w = Math.min(width, area.width);
        const h = Math.min(height, area.height);
        const x = Math.round(box.x + (box.width - w) / 2);
        const y = Math.round(box.y + (box.height - h) / 2);
        return {
          x: Math.min(Math.max(x, area.x), area.x + area.width - w),
          y: Math.min(Math.max(y, area.y), area.y + area.height - h),
          width: w,
          height: h
        };
      }
    }
    area = screen.getPrimaryDisplay().workArea;
    const w = Math.min(width, area.width);
    const h = Math.min(height, area.height);
    return {
      x: Math.round(area.x + (area.width - w) / 2),
      y: Math.round(area.y + (area.height - h) / 2),
      width: w,
      height: h
    };
  }

  /** 窗口当前是否还能被点到：至少 MIN_VISIBLE_X × MIN_VISIBLE_Y 落在某块屏幕的工作区里。 */
  function isReachable(box) {
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      const overlapX = Math.min(box.x + box.width, area.x + area.width) - Math.max(box.x, area.x);
      const overlapY = Math.min(box.y + box.height, area.y + area.height) - Math.max(box.y, area.y);
      return overlapX >= MIN_VISIBLE_X && overlapY >= MIN_VISIBLE_Y;
    });
  }

  /**
   * 显示器变化（拔副屏 / 改分辨率 / 主屏切换）后把窗口拉回可见区。
   * 拔掉副屏时窗口坐标可能整体落在不存在的屏幕上，用户既看不到也点不到，只能杀进程。
   */
  function relocateOffscreen() {
    windows.forEach((win) => {
      if (win.isDestroyed() || win.isMinimized()) {
        return;
      }
      const box = win.getBounds();
      if (isReachable(box)) {
        return;
      }
      const fallback = centerBox(box.width, box.height);
      win.setBounds(fallback);
      note('info', `[窗口] 显示器变化，已拉回可见区：${win.__sxwView || '?'}`);
    });
  }

  /** 非单例窗口（confirm#12 这类）没有自己的历史位置：借同视图最近一次的位置。 */
  function siblingBox(key) {
    const prefix = `${key.split('#')[0]}#`;
    const table = readBounds();
    const names = Object.keys(table).filter((name) => name.startsWith(prefix));
    if (!names.length) {
      return null;
    }
    names.sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    return table[names[0]] || null;
  }

  /** 解析窗口初始矩形：记忆值合法且还看得见就用它，否则落在主窗口中心。 */
  function resolveBox(key, def) {
    const saved = def.memory ? readBounds()[key] || (key.includes('#') ? siblingBox(key) : null) : null;
    const width = clampNumber(saved ? saved.width : undefined, def.minWidth || 320, MAX_SIDE, def.width);
    const height = clampNumber(saved ? saved.height : undefined, def.minHeight || 240, MAX_SIDE, def.height);
    // 必须用 Number.isFinite 判 y：以前写 `!Number(saved.y)`，把合法的 0（贴屏幕顶端）
    // 当成「没有记忆值」，每次都在屏幕中央重开，用户调好的位置永远存不住
    if (!saved || !Number.isFinite(Number(saved.x)) || !Number.isFinite(Number(saved.y))) {
      return centerBox(width, height);
    }
    const x = clampNumber(saved.x, -MAX_SIDE, MAX_SIDE, 0);
    const y = clampNumber(saved.y, -MAX_SIDE, MAX_SIDE, 0);
    if (!isReachable({ x, y, width, height })) {
      return centerBox(width, height);
    }
    // 非单例窗口会叠在同一坐标上（两个确认框完全重合，用户以为只开了一个）：
    // 按当前已开的同视图窗口数阶梯错开，最多错 6 级后回到原位
    if (key.includes('#')) {
      const prefix = key.split('#')[0];
      const opened = [...windows.values()].filter(
        (win) => !win.isDestroyed() && win.__sxwView === prefix
      ).length;
      const step = (opened % 6) * 24;
      return {
        x: clampNumber(x + step, -MAX_SIDE, MAX_SIDE, x),
        y: clampNumber(y + step, -MAX_SIDE, MAX_SIDE, y),
        width,
        height
      };
    }
    return { x, y, width, height };
  }

  function focusWindow(win) {
    if (!win || win.isDestroyed()) {
      return;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.moveTop();
    win.focus();
  }

  function winOf(event) {
    const sender = event && event.sender;
    if (!sender) {
      return null;
    }
    return winByWebContentsId(sender.id);
  }

  /** 按 webContents id 找窗口：结果回传要按「打开它的那一扇窗」精确定位，不能按视图名猜。 */
  function winByWebContentsId(id) {
    for (const win of windows.values()) {
      if (win.isDestroyed()) {
        continue;
      }
      if (win.webContents && win.webContents.id === id) {
        return win;
      }
    }
    return null;
  }

  function trustedWindowSender(event) {
    return Boolean(winOf(event));
  }

  /**
   * 打开（或聚焦）一个应用窗口。
   *
   * payload 由渲染进程定义，窗口通过 app-window:launch 取；
   * 单例窗口重复打开时不会新建，而是把新载荷推给已有窗口（例如历史窗口切换会话）。
   */
  function open(view, payload, openerId) {
    const def = WINDOW_DEFS[view];
    if (!def) {
      return { ok: false, error: `未知窗口：${view}` };
    }
    const from = Number(openerId) || 0;
    const existing = windows.get(view);
    if (existing && !existing.isDestroyed()) {
      payloads.set(existing.webContents.id, payload === undefined ? null : payload);
      openers.set(existing.webContents.id, from);
      if (!existing.webContents.isLoading()) {
        existing.webContents.send('app-window:payload', payload === undefined ? null : payload);
      }
      focusWindow(existing);
      return { ok: true, id: existing.id, focused: true };
    }

    const key = def.singleton === false ? `${view}#${++seq}` : view;
    const box = resolveBox(key, def);
    const theme = getTheme() === 'dark' ? 'dark' : 'light';
    const main = getMainWindow();
    let win;
    try {
      win = new BrowserWindow({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        minWidth: def.minWidth,
        minHeight: def.minHeight,
        maximizable: def.resizable !== false,
        resizable: def.resizable !== false,
        fullscreenable: false,
        frame: false,
        show: false,
        skipTaskbar: true,
        title: def.title || '随心问答',
        icon: iconPath && fs.existsSync(iconPath) ? iconPath : undefined,
        // 首帧底色与 styles.css 的 --bg 一致，避免深色主题下先闪一下白
        backgroundColor: theme === 'dark' ? '#0c0e10' : '#ffffff',
        // parent 让子窗口天然在父窗口之上、父窗口最小化时一起收起；不设 modal，主窗口照常可用
        parent: main && !main.isDestroyed() ? main : undefined,
        modal: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false
        }
      });
    } catch (error) {
      note('error', `[窗口] 创建失败：${view}`, error);
      return { ok: false, error: '窗口创建失败' };
    }

    win.__sxwView = view;
    windows.set(key, win);
    entries.set(win.webContents.id, path.join(rendererDir, 'app-window.html'));
    payloads.set(win.webContents.id, payload === undefined ? null : payload);
    openers.set(win.webContents.id, from);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) {
        return;
      }
      win.show();
      // 新开的窗口永远在已开窗口之上（同一父窗口的兄弟窗口按激活顺序叠放，这里显式顶上）
      win.moveTop();
      win.focus();
      note('info', `[窗口] 已显示：${view}`);
    });
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) {
        return;
      }
      // 读快照而不是闭包里的 payload：加载期间用户可能又点了一次「设置」，
      // 那次的新载荷已经写进 payloads；再发闭包旧值会让窗口回到上一次的状态
      win.webContents.send('app-window:payload', payloads.get(webContentsId) || null);
    });
    // 位置只在用户真的动过之后才有意义：close 时取 getNormalBounds（最大化态也能拿到还原尺寸）。
    // 长任务期间（备份 / 恢复 / 换库）不接关闭：子进程还在写库，窗口先没了会让用户以为已经失败。
    win.__sxwClosable = true;
    win.on('close', (event) => {
      if (win.__sxwClosable === false) {
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        if (!win.isDestroyed()) {
          win.webContents.send('app-window:close-blocked');
        }
        return;
      }
      persistBounds(key, win);
    });
    // closed 触发时 webContents 已经销毁：id 必须在建窗时就记住，
    // 否则这里读 win.webContents.id 会抛「Object has been destroyed」，进而把清理逻辑打断
    const webContentsId = win.webContents.id;
    const windowId = win.id;
    win.on('closed', () => {
      windows.delete(key);
      entries.delete(webContentsId);
      payloads.delete(webContentsId);
      const opener = openers.get(webContentsId) || 0;
      openers.delete(webContentsId);
      // 关窗也算一次结果：调用方据此解除「等待这个窗口回传」的挂起（否则 Promise 永远不落地）
      if (opener) {
        const target = winByWebContentsId(opener);
        if (target) {
          target.webContents.send('app-window:closed', { view, windowId });
        }
      } else if (typeof onClosed === 'function') {
        onClosed(view, { windowId, view });
      }
      // 最后一扇子窗口关闭后把焦点还给主窗口：无边框窗口在 Windows 上不一定会自动回焦，
      // 会出现「子窗口没了、主界面也不在焦点上」的错觉，用户容易误以为整个应用被最小化。
      // 不给最小化态的主窗口 focus：那会在用户主动收起的场景里把它弹回来
      if (windows.size === 0 && !closingAll) {
        const main = getMainWindow();
        // typeof 判断是为了单元测试里的窗口替身：它们只实现被断言到的方法。
        // 包 try 是因为销毁过程中取窗口状态可能抛错，清理路径不该因此中断
        try {
          if (main && !main.isDestroyed() && typeof main.isMinimized === 'function' && !main.isMinimized()) {
            main.focus();
          }
        } catch (error) {
          // 回焦失败不影响关窗
        }
      }
    });
    ['maximize', 'unmaximize'].forEach((name) => {
      win.on(name, () => {
        if (!win.isDestroyed()) {
          win.webContents.send('app-window:maximized-changed', win.isMaximized());
        }
      });
    });

    win.loadFile(path.join(rendererDir, 'app-window.html'), { query: { view } }).catch((error) => {
      note('error', `[窗口] 页面加载失败：${view}`, error);
      if (!win.isDestroyed()) {
        win.destroy();
      }
    });

    if (typeof onWindowCreated === 'function') {
      onWindowCreated(win);
    }
    return { ok: true, id: win.id, focused: false };
  }

  /** 关闭某个视图的全部窗口（不传 view 就全关）：退出流程用，绕过各窗口自己的守卫。 */
  function closeAll(view) {
    closingAll = true;
    try {
      windows.forEach((win, key) => {
        if (view && key.split('#')[0] !== view) {
          return;
        }
        persistBounds(key, win);
        if (!win.isDestroyed()) {
          win.destroy();
        }
      });
    } finally {
      closingAll = false;
    }
    windows.clear();
    entries.clear();
    payloads.clear();
    openers.clear();
  }

  /** 该用途是否有窗口开着：多开窗口的 key 带 #seq，不能只看 windows.get(view)。 */
  function has(view) {
    for (const [key, win] of windows.entries()) {
      if (key.split('#')[0] === view && win && !win.isDestroyed()) {
        return true;
      }
    }
    return false;
  }

  /** 按用途取一扇窗（多开时取最后打开的那扇）：冒烟与「切会话同步历史窗」用。 */
  function findByView(view) {
    let found = null;
    windows.forEach((win, key) => {
      if (key.split('#')[0] === view && win && !win.isDestroyed()) {
        found = win;
      }
    });
    return found;
  }

  /**
   * 静默推送载荷：只更新内容，不开窗、不抢焦点。
   * 用途是「切会话后历史窗口跟着换」——这条链路上抢焦点会让用户每切一次会话就丢一次输入位置。
   */
  function push(view, payload) {
    let count = 0;
    windows.forEach((win, key) => {
      if (key.split('#')[0] !== view || !win || win.isDestroyed()) {
        return;
      }
      const id = win.webContents.id;
      payloads.set(id, payload === undefined ? null : payload);
      if (!win.webContents.isLoading()) {
        win.webContents.send('app-window:payload', payload === undefined ? null : payload);
      }
      count += 1;
    });
    return count;
  }

  /** 广播给主窗口与全部子窗口：主题、登录态、当前会话、长任务互斥都走这里。 */
  function broadcast(channel, payload) {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send(channel, payload);
    }
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    });
  }

  /** 来源白名单：子窗口的 webContents.id → app-window.html，主进程据此判断 IPC 是否可信。 */
  function entryOf(webContentsId) {
    return entries.get(webContentsId) || '';
  }

  function isWindowWebContents(webContentsId) {
    return entries.has(webContentsId);
  }

  function registerIpc() {
    if (ipcReady) {
      return;
    }
    ipcReady = true;

    // 子窗口启动时取自己的视图名、载荷与主题；载荷不放进 query（附件 base64 可能很大）
    ipcMain.handle('app-window:launch', (event) => {
      const win = winOf(event);
      if (!win) {
        return null;
      }
      const view = String(win.__sxwView || '');
      const def = WINDOW_DEFS[view] || {};
      return {
        view,
        title: def.title || '',
        resizable: def.resizable !== false,
        payload: payloads.get(event.sender.id) || null,
        theme: getTheme() === 'dark' ? 'dark' : 'light'
      };
    });

    // 结果回传：确认框 / 重命名 / 登录这类「窗口收集输入、执行方另有其人」的流程走这里。
    // 结果只回给「打开它的那一方」：主窗口开的回主窗口，设置窗口开的回设置窗口——
    // 否则设置里点删除、确认框的结果会落到主窗口，闭包对不上，按钮就变成「点了没反应」。
    ipcMain.on('app-window:result', (event, data) => {
      const win = winOf(event);
      if (!win) {
        return;
      }
      const from = win.__sxwView;
      const windowId = win.id;
      const openerId = openers.get(event.sender.id) || 0;
      if (!openerId) {
        if (typeof onResult === 'function') {
          onResult(from, data, win);
        }
        return;
      }
      // 打开它的那扇窗可能不是单例（storage#3 这类），只能按 webContents id 找
      const target = winByWebContentsId(openerId);
      if (target) {
        target.webContents.send('app-window:reply', { from, data, windowId });
      }
    });

    ipcMain.on('app-window:close', (event) => {
      const win = winOf(event);
      if (!win || win.isDestroyed()) {
        return;
      }
      if (win.__sxwClosable === false) {
        win.webContents.send('app-window:close-blocked');
        return;
      }
      win.close();
    });
    ipcMain.on('app-window:minimize', (event) => {
      const win = winOf(event);
      if (win && !win.isDestroyed()) {
        win.minimize();
      }
    });
    ipcMain.on('app-window:toggle-maximize', (event) => {
      const win = winOf(event);
      if (!win || win.isDestroyed() || !win.isResizable()) {
        return;
      }
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    });
    ipcMain.handle('app-window:is-maximized', (event) => {
      const win = winOf(event);
      return Boolean(win && !win.isDestroyed() && win.isMaximized());
    });
    ipcMain.handle('app-window:set-pinned', (event, pinned) => {
      const win = winOf(event);
      if (!win || win.isDestroyed()) {
        return false;
      }
      win.setAlwaysOnTop(Boolean(pinned), 'floating');
      return Boolean(pinned);
    });
    ipcMain.handle('app-window:set-closable', (event, closable) => {
      const win = winOf(event);
      if (!win || win.isDestroyed()) {
        return false;
      }
      const next = Boolean(closable);
      // 真正生效的是这个标记：frame:false 没有系统关闭按钮，setClosable 只影响系统菜单；
      // Esc / Ctrl+W / 标题栏 × 全走 app-window:close，必须在这里统一挡住
      win.__sxwClosable = next;
      win.setClosable(next);
      return next;
    });
    ipcMain.handle('app-window:bounds', (event) => {
      const win = winOf(event);
      return win && !win.isDestroyed() ? win.getBounds() : null;
    });
    // 自绘缩放手柄：渲染进程按「按下时的 bounds + 指针位移」算新矩形，
    // 主进程只做范围校验——不在这里累计增量，避免 IPC 丢包导致尺寸漂移
    ipcMain.on('app-window:set-bounds', (event, box) => {
      const win = winOf(event);
      if (!win || win.isDestroyed() || !box || typeof box !== 'object') {
        return;
      }
      const min = win.getMinimumSize();
      const max = win.getMaximumSize();
      const width = clampNumber(box.width, min[0] || 200, max[0] || MAX_SIDE, 0);
      const height = clampNumber(box.height, min[1] || 120, max[1] || MAX_SIDE, 0);
      if (!width || !height) {
        return;
      }
      const x = clampNumber(box.x, -MAX_SIDE, MAX_SIDE, 0);
      const y = clampNumber(box.y, -MAX_SIDE, MAX_SIDE, 0);
      win.setBounds({ x, y, width, height });
    });
    // 主窗口与子窗口都可以再开下一个窗口（设置 → 切换存储 → 确认框）
    const openAllowed = (event) =>
      trustedWindowSender(event) || (typeof deps.isMainSender === 'function' && deps.isMainSender(event));

    // 主窗口对子窗口请求的答复（登录：窗口交凭据 → 主窗口校验并返回错误文案）
    ipcMain.on('app-window:reply', (event, view, data) => {
      if (typeof deps.isMainSender !== 'function' || !deps.isMainSender(event)) {
        return;
      }
      const win = findByView(String(view));
      if (win) {
        win.webContents.send('app-window:reply', data);
      }
    });
    ipcMain.handle('app-window:open', (event, view, payload) => {
      if (!openAllowed(event)) {
        return { ok: false, error: '不允许的调用来源' };
      }
      const opener = winOf(event);
      // openerId = 0 表示主窗口；否则记下打开者的 webContents id（不按视图名猜，多开窗口才不回错人）
      return open(view, payload, opener ? opener.webContents.id : 0);
    });
    // 静默推送：切会话时主窗口把新载荷送进已开的历史窗口，不抢焦点
    ipcMain.handle('app-window:push', (event, view, payload) => {
      if (typeof deps.isMainSender !== 'function' || !deps.isMainSender(event)) {
        return 0;
      }
      return push(String(view), payload);
    });
    // 主窗口的「更多」菜单据此生成窗口入口：注册表里标了 menu 的窗口自动出现
    ipcMain.handle('app-window:entries', (event) => (openAllowed(event) ? menuEntries() : []));

    // 显示器拔插 / 分辨率变化后把窗口拉回可见区；监听一次即可
    if (screen && typeof screen.on === 'function') {
      screen.on('display-removed', relocateOffscreen);
      screen.on('display-metrics-changed', relocateOffscreen);
    }
  }

  /** 视图名在建窗口时就固定下来：子窗口自己改不了要显示哪个视图。 */
  function markView(win, view) {
    win.__sxwView = view;
  }

  /** 注册表里标了 menu 的窗口：主窗口据此生成入口，新增窗口不用再改界面代码。 */
  function menuEntries() {
    return Object.entries(WINDOW_DEFS)
      .filter(([, def]) => def && def.menu)
      .map(([view, def]) => ({ view, title: def.title || view }));
  }

  return {
    registerIpc,
    open,
    push,
    closeAll,
    has,
    findByView,
    broadcast,
    entryOf,
    isWindowWebContents,
    markView,
    windowKeys: () => Array.from(windows.keys()),
    menuEntries,
    /** 冒烟自检用：拿到当前所有子窗口的视图名与 webContents（只读，不改状态）。 */
    listWindows: () =>
      Array.from(windows.entries()).map(([key, win]) => ({
        key,
        view: win.__sxwView || key.split('#')[0],
        webContents: win.webContents
      }))
  };
}

module.exports = { createWindowManager, WINDOW_DEFS };
