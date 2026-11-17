/**
 * 文件：desktop/test/app-windows.test.js
 * 职责：窗口工厂的纯逻辑单测——注册表、单例复用、来源白名单、结果回给「打开它的那一方」、
 *      广播覆盖面、退出时统一销毁，以及位置记忆的夹屏兜底。
 * 口径：不启动 Electron：BrowserWindow / ipcMain / screen 全部用最小替身注入。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWindowManager, WINDOW_DEFS } = require('../src/app-windows');

let seq = 0;

function fakeWebContents() {
  seq += 1;
  const listeners = new Map();
  return {
    id: seq,
    sent: [],
    loading: false,
    isLoading() {
      return false;
    },
    once(name, handler) {
      listeners.set(name, handler);
    },
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
    emit(name, ...args) {
      const handler = listeners.get(name);
      if (handler) {
        handler(...args);
      }
    }
  };
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.id = 1000 + FakeBrowserWindow.created.length + 1;
    // 记实例而不是构造参数：用例要读的是真实窗口（webContents / destroy 状态）
    FakeBrowserWindow.created.push(this);
    this.webContents = fakeWebContents();
    this.events = new Map();
    this.destroyed = false;
    this.visible = false;
    this.destroyedCount = 0;
  }

  on(name, handler) {
    this.events.set(name, handler);
  }

  once(name, handler) {
    this.events.set(name, handler);
  }

  show() {
    this.visible = true;
  }

  focus() {}

  moveTop() {}

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return false;
  }

  isMaximized() {
    return false;
  }

  isResizable() {
    return this.options.resizable !== false;
  }

  getBounds() {
    return { x: 10, y: 20, width: 800, height: 600 };
  }

  getNormalBounds() {
    return { x: 10, y: 20, width: 800, height: 600 };
  }

  getMinimumSize() {
    return [this.options.minWidth || 0, this.options.minHeight || 0];
  }

  getMaximumSize() {
    return [0, 0];
  }

  setBounds(box) {
    this.lastBounds = box;
  }

  setAlwaysOnTop(value) {
    this.pinned = value;
  }

  setClosable(value) {
    this.closable = value;
  }

  minimize() {}

  maximize() {}

  unmaximize() {}

  close() {
    const handler = this.events.get('close');
    if (handler) {
      handler();
    }
    this.destroy();
  }

  destroy() {
    this.destroyed = true;
    this.destroyedCount += 1;
    const handler = this.events.get('closed');
    if (handler) {
      handler();
    }
  }

  loadFile() {
    return Promise.resolve();
  }

  emit(name, ...args) {
    const handler = this.events.get(name);
    if (handler) {
      handler(...args);
    }
  }
}
FakeBrowserWindow.created = [];

function makeHarness(options) {
  const opts = options || {};
  // 每个用例从干净的创建记录开始：窗口序号与服务端 id 都按用例独立
  FakeBrowserWindow.created = [];
  const dir = opts.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-win-'));
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, handler) {
      listeners.set(channel, handler);
    }
  };
  const mainWindow = {
    webContents: { id: 1, send() {} },
    isDestroyed: () => false,
    isMinimized: () => false,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    isVisible: () => true
  };
  const results = [];
  const closed = [];
  const manager = createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => dir },
    ipcMain,
    screen: {
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    },
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    preloadPath: path.join(__dirname, '..', 'src', 'preload-window.js'),
    iconPath: path.join(__dirname, '..', 'build', 'icon.ico'),
    getTheme: () => 'light',
    getMainWindow: () => mainWindow,
    isMainSender: (event) => event.sender.id === mainWindow.webContents.id,
    onResult: (view, data, win) => results.push({ view, data, windowId: win && win.id }),
    onClosed: (view, info) => closed.push({ view, windowId: info && info.windowId }),
    log: () => {}
  });
  manager.registerIpc();
  return {
    manager,
    ipcMain,
    handlers,
    listeners,
    results,
    closed,
    mainWindow,
    dir,
    created: FakeBrowserWindow.created
  };
}

test('注册表覆盖了所有窗口，且都带尺寸与最小尺寸', () => {
  assert.ok(Object.keys(WINDOW_DEFS).length >= 12);
  Object.entries(WINDOW_DEFS).forEach(([name, def]) => {
    assert.ok(def.title, `${name} 缺标题`);
    assert.ok(def.width > 0 && def.height > 0, `${name} 缺默认尺寸`);
    assert.ok(def.minWidth > 0 && def.minHeight > 0, `${name} 缺最小尺寸`);
  });
  assert.strictEqual(WINDOW_DEFS.settings.resizable, true);
  assert.strictEqual(WINDOW_DEFS.confirm.resizable, false);
});

test('未知视图直接拒绝，不建窗口', () => {
  const { manager } = makeHarness();
  const before = FakeBrowserWindow.created.length;
  const result = manager.open('nope', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(FakeBrowserWindow.created.length, before);
});

test('单例窗口重复打开只聚焦已有那一个', () => {
  const { manager } = makeHarness();
  const first = manager.open('settings', { pane: 'appearance' });
  const second = manager.open('settings', { pane: 'models' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.focused, true);
  assert.strictEqual(FakeBrowserWindow.created.length, 1);
  assert.strictEqual(manager.has('settings'), true);
});

test('子窗口登记了入口页，IPC 白名单据此放行', () => {
  const { manager } = makeHarness();
  manager.open('settings', {});
  const win = FakeBrowserWindow.created[0];
  assert.strictEqual(manager.isWindowWebContents(win.webContents.id), true);
  assert.match(manager.entryOf(win.webContents.id), /app-window\.html$/);
});

test('parent 指主窗口但不设 modal：主窗口保持可交互', () => {
  const { manager, mainWindow } = makeHarness();
  manager.open('memory', { conversationId: 1 });
  const { options } = FakeBrowserWindow.created[0];
  assert.strictEqual(options.parent, mainWindow);
  assert.strictEqual(options.modal, false);
  assert.strictEqual(options.skipTaskbar, true);
  assert.strictEqual(options.frame, false);
});

test('结果只回给打开它的那一方：主窗口开的回主窗口，设置窗口开的回设置窗口', () => {
  const { manager, handlers, listeners, results, mainWindow } = makeHarness();
  manager.open('settings', {});
  const settingsWin = FakeBrowserWindow.created[0];
  // 设置窗口再开确认框：这条链的结果不能落到主窗口（闭包在设置窗口里）
  const openHandler = handlers.get('app-window:open');
  openHandler({ sender: settingsWin.webContents }, 'confirm', { title: '删除这个文件？' });
  const confirmWin = FakeBrowserWindow.created[1];

  listeners.get('app-window:result')({ sender: confirmWin.webContents }, { action: 'confirm' });
  assert.strictEqual(results.length, 0, '确认结果不该回主窗口');
  const reply = settingsWin.webContents.sent.find((item) => item.channel === 'app-window:reply');
  assert.ok(reply, '设置窗口要收到确认结果');
  assert.strictEqual(reply.payload.from, 'confirm');

  // 主窗口开的窗口，结果回主窗口
  openHandler({ sender: mainWindow.webContents }, 'rename', { id: 1, title: 'a' });
  const renameWin = FakeBrowserWindow.created[2];
  listeners.get('app-window:result')({ sender: renameWin.webContents }, { action: 'renamed', id: 1, title: 'b' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].view, 'rename');
  assert.strictEqual(results[0].data.title, 'b');
  // 主窗口要按窗口认领自己的回调：确认框可多开，没有 windowId 就只能猜
  assert.strictEqual(results[0].windowId, renameWin.id);
});

test('窗口没回结果就被关掉：主窗口收到 closed，同一扇单例窗口开两次不会串结果', () => {
  const { manager, closed, results } = makeHarness();
  const opened = manager.open('nickname', { nickname: 'a' });
  const win = FakeBrowserWindow.created[0];
  win.destroy();
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].windowId, opened.id);
  assert.strictEqual(closed[0].view, 'nickname');
  assert.strictEqual(results.length, 0, '关窗不该被当成一次确认结果');
});

test('静默推送只换载荷、不抢焦点，多开窗口也都能收到', () => {
  const { manager } = makeHarness();
  const first = manager.open('preview', { attachment: { id: 1 } });
  const second = manager.open('preview', { attachment: { id: 2 } });
  const wins = FakeBrowserWindow.created;
  wins.forEach((win) => {
    win.focus = () => {
      win.focused = (win.focused || 0) + 1;
    };
  });
  const pushed = manager.push('preview', { attachment: { id: 3 } });
  assert.strictEqual(pushed, 2);
  wins.forEach((win) => {
    const payload = win.webContents.sent.filter((item) => item.channel === 'app-window:payload').pop();
    assert.ok(payload, '每扇窗都要收到新载荷');
    assert.strictEqual(payload.payload.attachment.id, 3);
    assert.ok(!win.focused, '静默推送不该 focus');
  });
  // 多开窗口的 key 带 #seq，has() 不能只看 windows.get(view)
  assert.strictEqual(manager.has('preview'), true);
  assert.strictEqual(manager.has('settings'), false);
  assert.strictEqual(first.ok && second.ok, true);
});

test('长任务期间关闭被挡住：发 close-blocked，窗口不销毁', () => {
  const harness = makeHarness();
  harness.manager.open('save', { mode: 'backup' });
  const target = FakeBrowserWindow.created[0];
  const setClosable = harness.handlers.get('app-window:set-closable');
  const closeChannel = harness.listeners.get('app-window:close');

  setClosable({ sender: target.webContents }, false);
  closeChannel({ sender: target.webContents });
  assert.strictEqual(target.destroyed, false, '执行中不该被关掉');
  assert.ok(
    target.webContents.sent.some((item) => item.channel === 'app-window:close-blocked'),
    '要告诉窗口为什么关不掉'
  );

  setClosable({ sender: target.webContents }, true);
  closeChannel({ sender: target.webContents });
  assert.strictEqual(target.destroyed, true, '完成后可以正常关闭');
});

test('关闭主流程时统一销毁全部子窗口', () => {
  const { manager } = makeHarness();
  manager.open('settings', {});
  manager.open('confirm', { title: 'x' });
  const wins = FakeBrowserWindow.created.slice(-2);
  manager.closeAll();
  assert.deepStrictEqual(
    wins.map((win) => win.destroyed),
    [true, true]
  );
  assert.strictEqual(manager.isWindowWebContents(wins[0].webContents.id), false);
});

test('关闭最后一扇子窗口后把焦点还给主窗口，整批销毁时不抢焦点', () => {
  const { manager, mainWindow } = makeHarness();

  // 单扇关闭：焦点回到主窗口（否则「子窗口没了、主界面也不在焦点上」会被当成整体被最小化）
  manager.open('settings', {});
  const settingsWin = FakeBrowserWindow.created.slice(-1)[0];
  mainWindow.focusCount = 0;
  settingsWin.close();
  assert.strictEqual(mainWindow.focusCount, 1);

  // 退出流程的 closeAll：逐窗回焦会抢一帧前台再把主窗口藏起来，所以整批销毁期间不回焦
  manager.open('settings', {});
  manager.open('confirm', { title: 'x' });
  mainWindow.focusCount = 0;
  manager.closeAll();
  assert.strictEqual(mainWindow.focusCount, 0);
});

test('广播同时覆盖主窗口与全部子窗口', () => {
  const { manager, mainWindow } = makeHarness();
  const mainSent = [];
  mainWindow.webContents.send = (channel, payload) => mainSent.push({ channel, payload });
  manager.open('settings', {});
  manager.open('confirm', { title: 'x' });
  const wins = FakeBrowserWindow.created.slice(-2);
  manager.broadcast('app:config-changed', { theme: 'dark' });
  assert.strictEqual(mainSent.length, 1);
  wins.forEach((win) => {
    assert.ok(win.webContents.sent.some((item) => item.channel === 'app:config-changed'));
  });
});

test('记忆的位置在屏幕外时夹回主屏幕中心', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-win-'));
  fs.writeFileSync(
    path.join(dir, 'window-bounds.json'),
    JSON.stringify({ settings: { x: 9000, y: 9000, width: 800, height: 600 } }),
    'utf8'
  );
  const { manager } = makeHarness({ userData: dir });
  manager.open('settings', {});
  const { options } = FakeBrowserWindow.created[0];
  assert.ok(options.x < 1920 && options.y < 1080, '窗口不该落在屏幕外');
  assert.ok(options.x >= 0 && options.y >= 0);
});

test('首次打开用注册表里的默认尺寸，不是最小尺寸', () => {
  const { manager } = makeHarness();
  manager.open('memory', {});
  const { options } = FakeBrowserWindow.created[0];
  // 回归：clampNumber(null) 曾被 Number(null)=0 骗过，Math.max(min, 0) 直接把窗口夹成 minWidth×minHeight，
  // 表现是所有子窗口第一次打开都挤在最小尺寸
  assert.strictEqual(options.width, WINDOW_DEFS.memory.width);
  assert.strictEqual(options.height, WINDOW_DEFS.memory.height);
  assert.ok(options.width > WINDOW_DEFS.memory.minWidth);
});

test('记忆里只有坐标、没有宽高时回落到默认尺寸', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-win-'));
  fs.writeFileSync(path.join(dir, 'window-bounds.json'), JSON.stringify({ memory: { x: 40, y: 30 } }), 'utf8');
  const { manager } = makeHarness({ userData: dir });
  manager.open('memory', {});
  const { options } = FakeBrowserWindow.created[0];
  assert.strictEqual(options.width, WINDOW_DEFS.memory.width);
  assert.strictEqual(options.height, WINDOW_DEFS.memory.height);
});

test('记忆里的合法尺寸照旧生效（用户拉大过就记住）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-win-'));
  fs.writeFileSync(
    path.join(dir, 'window-bounds.json'),
    JSON.stringify({ memory: { x: 300, y: 200, width: 520, height: 610 } }),
    'utf8'
  );
  const { manager } = makeHarness({ userData: dir });
  manager.open('memory', {});
  const { options } = FakeBrowserWindow.created[0];
  assert.strictEqual(options.width, 520);
  assert.strictEqual(options.height, 610);
});
