/**
 * 文件：desktop/src/renderer/app-window.js
 * 职责：独立子窗口的外壳逻辑——取启动信息、套主题与字号、标题栏按钮、图钉、自绘缩放、Esc/Ctrl+W，
 *      按视图名动态加载 views/<view>.js 并把容器交给它。
 * 口径：视图只负责自己那块 DOM 与交互；窗口能力（关/最小化/最大化/置顶/缩放/结果回传）一律经
 *      windowBridge，视图不直接碰 IPC 频道。
 */
(function () {
  'use strict';

  const bridge = window.windowBridge;
  const kit = window.SXW_WIN;
  const { qs, qsa } = kit;

  let launch = { view: '', title: '', payload: null, theme: 'light', resizable: false };
  let viewApi = null;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  }

  function applyFont(scale) {
    const allowed = ['small', 'normal', 'large'];
    document.documentElement.dataset.font = allowed.includes(scale) ? scale : 'normal';
  }

  function setTitle(text) {
    const title = String(text || launch.title || '随心问答');
    qs('#aw-title').textContent = title;
    document.title = title;
  }

  function close() {
    bridge.close();
  }

  /** 结果回传：收集输入型窗口（确认 / 重命名 / 登录 / 昵称）把结果交回主窗口执行。 */
  function sendResult(data) {
    bridge.sendResult(data);
  }

  async function setClosable(closable) {
    return bridge.setClosable(Boolean(closable));
  }

  function bindTitleBar() {
    // 标题栏里没有最小化键（见 app-window.html 的注释）：子窗口是附属窗口，收起直接关掉；
    // 且 skipTaskbar 让最小化后的子窗口在任务栏没有入口，非单例窗口会彻底找不回来。
    qs('#aw-close').addEventListener('click', () => close());
    const maxButton = qs('#aw-max');
    // 固定尺寸窗口不显示最大化按钮：点了没反应比没有按钮更让人困惑
    if (!launch.resizable) {
      maxButton.hidden = true;
    }
    maxButton.addEventListener('click', () => bridge.toggleMaximize());

    const syncMaxState = (maximized) => {
      document.body.classList.toggle('is-maximized', Boolean(maximized));
      maxButton.classList.toggle('is-maximized', Boolean(maximized));
      maxButton.title = maximized ? '还原' : '最大化';
    };
    bridge.isMaximized().then(syncMaxState).catch(() => {});
    bridge.onMaximizedChanged(syncMaxState);

    // 双击标题栏 = 最大化 / 还原（Windows 习惯），固定尺寸窗口不响应
    const bar = qs('.aw-bar');
    bar.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) {
        return;
      }
      if (launch.resizable) {
        bridge.toggleMaximize();
      }
    });

    // 图钉：默认不置顶（否则会浮在别的软件之上），用户主动开启
    const pin = qs('#aw-pin');
    pin.addEventListener('click', async () => {
      const next = !pin.classList.contains('is-on');
      const applied = await bridge.setPinned(next);
      pin.classList.toggle('is-on', Boolean(applied));
      pin.title = applied ? '取消置顶' : '置顶显示';
      pin.setAttribute('aria-pressed', applied ? 'true' : 'false');
    });

    document.addEventListener('keydown', (event) => {
      // Ctrl+W 关闭窗口；Esc 交给视图先用（确认框的 Esc = 取消并回传结果）
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Escape') {
        return;
      }
      if (viewApi && typeof viewApi.onEscape === 'function' && viewApi.onEscape() !== false) {
        return;
      }
      close();
    });

    // 长任务执行中关不掉：主进程统一挡住 × / Esc / Alt+F4，这里只负责把原因说清楚
    bridge.onCloseBlocked(() => {
      kit.toast('正在执行，完成前不能关闭这个窗口', 'error');
    });
  }

  /**
   * 自绘缩放：按下时取一次当前 bounds，之后按「起点 + 指针位移」算新矩形。
   * 不累计增量——IPC 少一帧就会漂移，用户会看到窗口越缩越小。
   */
  function bindResize() {
    qsa('.aw-resize').forEach((handle) => {
      handle.addEventListener('pointerdown', async (event) => {
        if (event.button !== 0 || !launch.resizable) {
          return;
        }
        if (document.body.classList.contains('is-maximized')) {
          return;
        }
        const start = await bridge.getBounds();
        if (!start) {
          return;
        }
        const edge = String(handle.dataset.edge || '');
        const originX = event.screenX;
        const originY = event.screenY;
        let frame = 0;
        if (typeof handle.setPointerCapture === 'function') {
          handle.setPointerCapture(event.pointerId);
        }
        const onMove = (move) => {
          if (frame) {
            return;
          }
          frame = requestAnimationFrame(() => {
            frame = 0;
            const dx = move.screenX - originX;
            const dy = move.screenY - originY;
            const box = { x: start.x, y: start.y, width: start.width, height: start.height };
            if (edge.includes('e')) {
              box.width = start.width + dx;
            }
            if (edge.includes('s')) {
              box.height = start.height + dy;
            }
            if (edge.includes('w')) {
              box.width = start.width - dx;
              box.x = start.x + dx;
            }
            if (edge.includes('n')) {
              box.height = start.height - dy;
              box.y = start.y + dy;
            }
            bridge.setBounds(box);
          });
        };
        const onUp = () => {
          if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    });
  }

  /** 按视图名加载 views/<view>.js（classic script，挂到 window.SXW_VIEWS）。 */
  function loadViewScript(view) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `views/${view}.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`视图脚本不存在：views/${view}.js`));
      document.body.appendChild(script);
    });
  }

  function showFatal(message) {
    const root = qs('#aw-root');
    root.textContent = '';
    root.appendChild(kit.h('p', { class: 'preview-empty', text: message }));
  }

  async function boot() {
    const info = await bridge.launch();
    if (!info || !info.view) {
      showFatal('窗口启动信息缺失，请关闭本窗口重试。');
      return;
    }
    launch = info;
    applyTheme(info.theme);
    // 载荷里带标题就优先用它：历史窗口要显示会话名，而不是固定的「对话历史」
    setTitle((info.payload && info.payload.title) || info.title);
    // 字号从配置读：子窗口也要跟主窗口一致
    try {
      const conf = await bridge.readConfig();
      applyFont(conf && conf.fontScale);
    } catch (error) {
      applyFont('normal');
    }

    bindTitleBar();
    bindResize();

    // 主题 / 字号实时跟随：任何窗口改完，其它窗口 100ms 内变过来
    bridge.onConfigChanged((conf) => {
      if (!conf) {
        return;
      }
      applyTheme(conf.theme);
      applyFont(conf.fontScale);
      if (viewApi && typeof viewApi.onConfigChanged === 'function') {
        viewApi.onConfigChanged(conf);
      }
    });
    bridge.onAuthChanged((auth) => {
      if (viewApi && typeof viewApi.onAuthChanged === 'function') {
        viewApi.onAuthChanged(auth || {});
      }
    });

    try {
      await loadViewScript(info.view);
    } catch (error) {
      showFatal('这个窗口的界面没有加载成功，请更新版本后重试。');
      return;
    }
    const definition = window.SXW_VIEWS && window.SXW_VIEWS[info.view];
    if (!definition || typeof definition.mount !== 'function') {
      showFatal('这个窗口还没有实现。');
      return;
    }

    const ctx = {
      payload: info.payload,
      bridge,
      kit,
      close,
      result: sendResult,
      setTitle,
      setClosable,
      openWindow: (view, payload) => bridge.openWindow(view, payload),
      toast: kit.toast
    };
    const root = qs('#aw-root');
    try {
      viewApi = definition.mount(root, ctx) || null;
    } catch (error) {
      console.error('[窗口] 视图挂载失败', error);
      showFatal('这个窗口打开时出错，请关闭后重试。');
      return;
    }
    // 单例窗口被再次打开时（换个会话看历史、确认框换一条文案），主进程推来新载荷。
    // 视图自己会增量刷新就交给它；否则整块重挂——表单绝不能停在上一次的载荷上
    // （重命名窗口拿着旧标题、确认框拿着旧文案去执行新闭包，是最坏的一类错）。
    bridge.onPayload((payload) => {
      // 标题跟着内容走：历史窗口切会话后，标题栏必须显示新会话名
      if (payload && payload.title) {
        setTitle(payload.title);
      }
      if (viewApi && typeof viewApi.onPayload === 'function') {
        // 视图返回 false = 「我不处理，请整块重挂」；返回其它值 = 已经自己刷新完了
        if (viewApi.onPayload(payload) !== false) {
          return;
        }
      }
      if (viewApi && typeof viewApi.destroy === 'function') {
        try {
          viewApi.destroy();
        } catch (error) {
          console.error('[窗口] 视图释放失败', error);
        }
      }
      const nextCtx = Object.assign({}, ctx, { payload });
      const node = qs('#aw-root');
      node.textContent = '';
      try {
        viewApi = definition.mount(node, nextCtx) || null;
      } catch (error) {
        console.error('[窗口] 视图重新挂载失败', error);
        showFatal('窗口内容刷新失败，请关闭后重试。');
      }
    });
    // 关窗前释放视图持有的资源（图片 blob URL 之类），否则长会话反复开窗会累积
    window.addEventListener('beforeunload', () => {
      if (viewApi && typeof viewApi.destroy === 'function') {
        try {
          viewApi.destroy();
        } catch (error) {
          console.error('[窗口] 视图释放失败', error);
        }
      }
    });
  }

  boot().catch((error) => {
    console.error('[窗口] 初始化失败', error);
    showFatal('窗口初始化失败，请关闭后重试。');
  });
})();
