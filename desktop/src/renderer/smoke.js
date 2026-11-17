/**
 * 文件：desktop/src/renderer/smoke.js
 * 职责：界面自检与冒烟场景的唯一实现（原在 app.js 段落 15）。
 *
 * 为什么单独成文件并动态加载：这些断言与场景代码只在 `npm run smoke`（主进程 --smoke）时用得到，
 * 却会被 electron-builder 的 `src/**` 原样打进生产包，等于给正式用户装了一整套可以驱动界面的测试入口。
 * 现在正常启动路径完全不引入本文件，打包配置也显式排除了它（见 package.json build.files）。
 *
 * 依赖注入：本文件不引用 app.js 里的任何全局名字，需要的能力由 app.js 在加载后显式传入。
 * 这样 eslint 的 no-undef 仍然有效（不用为一堆跨文件全局加豁免），也让「冒烟到底碰了哪些内部状态」一目了然。
 */
(function (global) {
  'use strict';

  const SCENARIO_TIMEOUT_MS = 12000; // 单个等待条件的默认上限：够慢机器跑完一轮流式 + 开一扇子窗口

  function wait(ms) {
    return new Promise((resolve) => global.setTimeout(resolve, ms));
  }

  async function waitUntil(check, timeoutMs, stepMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await wait(stepMs || 100);
    }
    return false;
  }

  /** 条件需要跨窗口取值（含 await）时用这个版本：waitUntil 只接受同步判断。 */
  async function waitUntilAsync(check, timeoutMs, stepMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await wait(stepMs || 120);
    }
    return false;
  }

  /**
   * 造出场景实现；所有依赖都从 deps 取，函数体内不出现任何跨文件全局。
   * deps 里传的是 app.js 的活引用（dom / state 是对象，函数是声明），所以运行期拿到的是最新状态。
   */
  function createSmokeApi(deps) {
    const { dom, state, getConfig, constants, updateComposer } = deps;
    const { sendMessage, stopGenerating, pickAttachment, handleMenuAction } = deps;
    const { flushDraft, currentTheme, openChatSearch, runChatSearch, closeChatSearch } = deps;
    const markdown = deps.markdown;
    const THEME_LIGHT = constants.THEME_LIGHT;
    const THEME_DARK = constants.THEME_DARK;

    // --- 子窗口驱动：通道只在 --smoke 下由主进程注册，正式启动 invoke 直接失败 ---
    const bridge = global.desktopBridge || {};

    async function windowEval(view, code) {
      if (typeof bridge.smokeWindow !== 'function') {
        return { ok: false, error: 'unsupported' };
      }
      return bridge.smokeWindow(view, code);
    }

    async function windowValue(view, code) {
      const result = await windowEval(view, code);
      return result && result.ok ? result.value : undefined;
    }

    async function windowOpen(view) {
      const list = typeof bridge.smokeWindows === 'function' ? await bridge.smokeWindows() : [];
      return Array.isArray(list) && list.includes(view);
    }

    async function waitWindowReady(view, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 10000);
      while (Date.now() < deadline) {
        if (await windowOpen(view)) {
          const mounted = await windowValue(
            view,
            'Boolean(document.querySelector("#aw-root") && document.querySelector("#aw-root").childElementCount > 0)'
          );
          if (mounted) {
            return true;
          }
        }
        await wait(120);
      }
      return false;
    }

    async function waitWindowClosed(view, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 8000);
      while (Date.now() < deadline) {
        if (!(await windowOpen(view))) {
          return true;
        }
        await wait(120);
      }
      return false;
    }

    async function windowClick(view, selector) {
      return Boolean(
        await windowValue(
          view,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`
        )
      );
    }

    async function windowSetValue(view, selector, value) {
      const literal = JSON.stringify(String(value));
      return Boolean(
        await windowValue(
          view,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${literal}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
        )
      );
    }

    async function windowHas(view, selector) {
      return Boolean(await windowValue(view, `Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    }

    async function waitWindowHas(view, selector, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 8000);
      while (Date.now() < deadline) {
        if (await windowHas(view, selector)) {
          return true;
        }
        await wait(120);
      }
      return false;
    }

    async function windowClickAt(view, selector, index) {
      const code = `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return false; el.click(); return true; })()`;
      return Boolean(await windowValue(view, code));
    }

    async function windowSetAt(view, selector, index, value) {
      const literal = JSON.stringify(String(value));
      const code = `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return false; el.value = ${literal}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
      return Boolean(await windowValue(view, code));
    }

    async function windowText(view, selector) {
      const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : ""; })()`;
      return String((await windowValue(view, code)) || '');
    }

    async function windowEscape(view) {
      await windowValue(
        view,
        '(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()'
      );
    }

    function aiBubbles() {
      return Array.from(dom['message-list'].querySelectorAll('.msg-row.is-ai .bubble'));
    }

    function smokeReport() {
      const failures = [];
      const width = (selector) => {
        const element = document.querySelector(selector);
        return element ? Math.round(element.getBoundingClientRect().width) : 0;
      };
      const height = (selector) => {
        const element = document.querySelector(selector);
        return element ? Math.round(element.getBoundingClientRect().height) : 0;
      };

      [
        'session-list',
        'user-card',
        'offline-banner',
        'offline-text',
        'btn-offline-retry',
        'select-model',
        'message-list',
        'input-message',
        'btn-send',
        'counter',
        'disclaimer',
        'attach-bar'
      ].forEach((id) => {
        if (!document.getElementById(id)) {
          failures.push(`missing:${id}`);
        }
      });

      // 主窗口只承载聊天与导航：任何遮罩 / 全屏浮层都不该再留在页面里
      if (document.querySelectorAll('.modal-mask, .switch-overlay, .lightbox').length) {
        failures.push('main-window-has-overlay');
      }
      if (!dom['attach-bar'].hidden) {
        failures.push('attach-bar-init-hidden');
      }

      // 尺寸口径 = styles.css 的 --titlebar-height / 侧栏宽度（改设计就同步改这两个数）
      if (height('.titlebar') !== 44) {
        failures.push('titlebar-height');
      }
      if (width('.sidebar') !== 272) {
        failures.push('sidebar-width');
      }
      // 顶栏结构：连接状态在设置窗口的「连接」分区里（由 enhance 场景在窗口内断言），
      // 侧栏收起键在顶栏最左
      if (document.querySelector('.main-top #status-dot')) {
        failures.push('conn-state-still-in-topbar');
      }
      if (!document.querySelector('.main-top #btn-sidebar-collapse')) {
        failures.push('sidebar-collapse-not-in-topbar');
      }
      if (document.querySelector('.sidebar-head #btn-sidebar-collapse')) {
        failures.push('sidebar-collapse-still-in-sidebar');
      }

      if (dom['counter'].textContent !== '0 / 4000') {
        failures.push('counter-init');
      }
      if (!dom['btn-send'].disabled) {
        failures.push('send-enabled-when-empty');
      }

      dom['input-message'].value = '测试';
      updateComposer();
      if (dom['counter'].textContent !== '2 / 4000') {
        failures.push('counter-count');
      }
      if (dom['btn-send'].disabled) {
        failures.push('send-disabled-with-text');
      }
      dom['input-message'].value = '';
      updateComposer();

      const theme = document.documentElement.dataset.theme;
      if (theme !== THEME_LIGHT && theme !== THEME_DARK) {
        failures.push('theme-attr');
      }

      return {
        failures,
        theme,
        sidebarWidth: width('.sidebar'),
        titlebarHeight: height('.titlebar'),
        inputHeight: height('.input-message')
      };
    }

    // 冒烟场景（每个场景一次 `npm run smoke`；场景清单与唯一源）：
    // offline 离线容错 / chat 流式与 Markdown / stop 停止生成 / error 错误提示 / sessions 会话列表与删除 /
    // sessions-view 会话观看态 / login 登录注册与认领 / login-view 登录窗口观看态 /
    // enhance 桌面增强（菜单快捷键 / 设置窗口 / 附件上传与灯箱 / 导出 / 历史窗口）/ enhance-view 增强观看态 /
    // restore 恢复窗口与「Esc 只关它自己」/ prompt 新增窗口的扩展性验收 /
    // rounds 连续 10 轮对话（总验收用，第 2 条的桌面端链路证据）
    async function runSmokeScenario(name) {
      const failures = [];
      const notes = [];
      const record = (ok, label) => {
        if (!ok) {
          failures.push(label);
        }
        notes.push(`${ok ? 'ok' : 'fail'}:${label}`);
      };

      if (name === 'offline') {
        record(await waitUntil(() => state.online === false, 6000), 'offline-detected');
        record(dom['conn-text'].classList.contains('is-offline'), 'conn-text-offline');
        record(dom['conn-text'].textContent === '离线', 'conn-text');
        // 离线界面激活（横幅 + 侧栏占位真的出现，别只是状态点变色）
        record(
          !dom['offline-banner'].hidden && dom['offline-text'].textContent.includes('后端连接失败'),
          'offline-banner'
        );
        record(Boolean(dom['session-list'].querySelector('.session-offline')), 'session-offline-placeholder');
        const sent = await sendMessage('你好');
        record(sent === false, 'send-blocked-when-offline');
        record(dom['message-list'].querySelectorAll('.msg-row').length === 0, 'no-bubble-when-offline');
        record(dom.toast && !dom.toast.hidden && dom.toast.textContent.includes('后端未启动'), 'offline-toast');
        return { scenario: name, failures, notes, online: state.online };
      }

      record(await waitUntil(() => state.online === true, 8000), 'backend-online');
      record(dom['conn-text'].classList.contains('is-online'), 'conn-text-online');
      record(dom['conn-text'].textContent === '已连接', 'conn-text');
      record(await waitUntil(() => state.models.length > 0, 8000), 'models-loaded');
      record(
        dom['model-select-list'].querySelectorAll('.model-option').length === state.models.length + 1,
        'model-options'
      );

      if (name === 'chat') {
        record((await sendMessage('你好')) === true, 'send-accepted');
        record(await waitUntil(() => state.generating === false, 15000), 'chat-finished');
        const bubble = aiBubbles()[0];
        const text = bubble ? bubble.textContent : '';
        record(Boolean(bubble), 'ai-bubble');
        record(text.includes('mock 流式回复'), 'content-rendered');
        record(Boolean(bubble) && bubble.querySelectorAll('strong').length > 0, 'markdown-bold');
        record(Boolean(bubble) && bubble.querySelectorAll('h1').length > 0, 'markdown-heading');
        record(Boolean(bubble) && bubble.querySelectorAll('.code-block code').length > 0, 'markdown-code');
        record(Boolean(bubble) && bubble.querySelectorAll('li').length > 0, 'markdown-list');
        // 消息操作条与代码块工具栏：AI 行外挂操作条，代码块自带复制按钮
        const stack = bubble ? bubble.closest('.msg-stack') : null;
        record(Boolean(stack && stack.querySelector('.msg-action[data-action="copy"]')), 'msg-copy-action');
        record(Boolean(stack && stack.querySelector('.msg-action[data-action="regen"]')), 'msg-regen-action');
        record(Boolean(bubble && bubble.querySelector('.code-copy')), 'code-copy-action');
        record(Boolean(bubble && bubble.querySelector('table th')), 'markdown-table');
        record(Boolean(bubble && bubble.querySelector('.task-item.is-done')), 'markdown-task');

        // 长代码块折叠：默认折着 → 点「展开」文案变「收起」→ 用同一段原文重渲染仍保持展开
        const toggler = bubble ? bubble.querySelector('.code-toggle') : null;
        record(Boolean(toggler), 'code-toggle-present');
        if (toggler) {
          const foldBlock = toggler.closest('.code-block');
          record(Boolean(foldBlock && foldBlock.classList.contains('is-collapsed')), 'code-collapsed-initially');
          toggler.click();
          record(Boolean(foldBlock && !foldBlock.classList.contains('is-collapsed')), 'code-expanded-on-click');
          const labelAfter = bubble.querySelector('.code-toggle');
          record(Boolean(labelAfter) && labelAfter.textContent.trim() === '收起', 'code-toggle-label');
          // 重渲染：流式每一帧都是整块重绘，展开状态必须靠 expandedCode 记住
          bubble.innerHTML = markdown().renderMarkdown(bubble.dataset.raw || '');
          const rerendered = bubble.querySelector('.code-block');
          record(
            Boolean(rerendered) && !rerendered.classList.contains('is-collapsed'),
            'code-stays-expanded'
          );
        }

        // 重新生成：只替换最后一条回复，不新增用户消息（后端覆盖 assistant，不是追加问答）
        const usersBefore = dom['message-list'].querySelectorAll('.msg-row.is-user').length;
        const aiRows = Array.from(dom['message-list'].querySelectorAll('.msg-row.is-ai'));
        const regenButton = aiRows.length
          ? aiRows[aiRows.length - 1].querySelector('.msg-action[data-action="regen"]')
          : null;
        if (regenButton) {
          regenButton.click();
          record(await waitUntil(() => state.generating === false, 15000), 'regenerate-finished');
          record(
            await waitUntil(
              () => dom['message-list'].querySelectorAll('.msg-row.is-ai').length === 1,
              5000
            ),
            'regenerate-single-ai'
          );
          record(
            dom['message-list'].querySelectorAll('.msg-row.is-user').length === usersBefore,
            'regenerate-no-new-user'
          );

          // 回退一步：重新生成后能切回上一版，按钮用过即消失
          const revertButton = Array.from(dom['message-list'].querySelectorAll('.msg-action')).find(
            (item) => item.textContent === '回退上一版'
          );
          record(Boolean(revertButton), 'revert-button-shown');
          if (revertButton) {
            revertButton.click();
            record(
              await waitUntil(() => {
                const rows = dom['message-list'].querySelectorAll('.msg-row.is-ai .bubble');
                return rows.length > 0 && rows[rows.length - 1].textContent.includes('上一版回答');
              }, 5000),
              'revert-applied'
            );
          }
        }
        record(Boolean(bubble) && !bubble.querySelector('script'), 'xss-not-injected');
        record(text.includes('<script>'), 'xss-escaped-text');
        record(state.conversationId === 12, 'conversation-id');
        record(!dom['message-list'].querySelector('.cursor'), 'cursor-cleared');
        record(!dom['btn-send'].classList.contains('is-stop'), 'send-restored');
      }

      if (name === 'stop') {
        // 不 await：先把请求发出去，才有时机点「停止」
        const pending = sendMessage('slow');
        if (pending && typeof pending.catch === 'function') {
          pending.catch(() => {});
        }
        record(await waitUntil(() => state.generating === true, 3000), 'generating-started');
        // 必须等「首字真的到了」再点停止：初始气泡里有「思考中…」占位，只看 textContent 非空会恒真，
        // 从而在首个 chunk 到达前就 abort，停止后气泡必然为空（B37 竞态）
        record(
          await waitUntil(() => {
            const first = aiBubbles()[0];
            return Boolean(first) && !first.classList.contains('is-thinking') && first.textContent.length > 0;
          }, 6000),
          'stream-started'
        );
        record(dom['btn-send'].classList.contains('is-stop'), 'stop-button-shown');
        stopGenerating();
        record(await waitUntil(() => state.generating === false, 6000), 'stopped');
        await pending;
        const bubble = aiBubbles()[0];
        record(Boolean(bubble) && bubble.textContent.length > 0, 'partial-kept');
        const note = dom['message-list'].querySelector('.msg-note');
        record(Boolean(note) && note.textContent === '已停止生成', 'stopped-note');
        record(!dom['message-list'].querySelector('.thinking'), 'thinking-cleared');
        record(!dom['btn-send'].classList.contains('is-stop'), 'send-restored');
      }

      if (name === 'error') {
        record((await sendMessage('error')) === true, 'send-accepted');
        record(await waitUntil(() => state.generating === false, 10000), 'error-finished');
        const errorRow = dom['message-list'].querySelector('.msg-row.is-error');
        record(Boolean(errorRow), 'error-bubble');
        record(Boolean(errorRow) && errorRow.textContent.includes('模型调用失败'), 'error-reason');
        record(Boolean(errorRow) && Boolean(errorRow.querySelector('.btn-retry')), 'retry-button');
      }

      if (name === 'login-view') {
        // 只做「观看态」：打开登录窗口，供自检截图留证
        record(await waitUntil(() => state.conversations.length === 2, 8000), 'anonymous-list');
        dom['user-card'].click();
        record(await waitWindowReady('auth', 10000), 'auth-window-opened');
        record((await windowValue('auth', 'document.querySelectorAll(".auth-tab").length')) === 2, 'auth-tabs');
        record(await windowHas('auth', '.auth-tab.is-active'), 'password-tab-default');
        record(
          (await windowValue('auth', 'document.querySelectorAll(".auth-field[hidden]").length')) >= 2,
          'register-only-fields-hidden'
        );
      }

      if (name === 'login') {
        record(await waitUntil(() => state.conversations.length === 2, 8000), 'anonymous-list');
        record(dom['user-name'].textContent === '未登录', 'user-card-logged-out');
        record(dom['login-hint'].hidden === false && dom['btn-logout'].hidden === true, 'login-hint-visible');

        dom['user-card'].click();
        record(await waitWindowReady('auth', 10000), 'auth-window-opened');
        record((await windowValue('auth', 'document.querySelectorAll(".auth-tab").length')) === 2, 'auth-tabs');
        record(await windowHas('auth', '.auth-input-row input[type="password"]'), 'password-tab-fields');

        // 1. 错误路径：密码错 → 窗口内中文提示且窗口不关（401 不得被当成「登录态失效」清账号）
        record(await windowSetValue('auth', '.auth-field input[type="text"]', 'tester@example.com'), 'auth-username-typed');
        record(await windowSetValue('auth', '.auth-input-row input[type="password"]', 'wrong-password'), 'auth-password-typed');
        record(await windowClick('auth', '.auth-submit'), 'auth-submit-clicked');
        record(
          await waitUntilAsync(
            async () => (await windowText('auth', '.auth-tip')).includes('用户名或密码错误'),
            SCENARIO_TIMEOUT_MS
          ),
          'wrong-password-tip'
        );
        record(await windowOpen('auth'), 'window-kept-on-error');

        // 2. 注册 tab：账号 + 密码 + 确认密码，注册成功即登录（请求仍由主窗口完成）
        record(await windowClickAt('auth', '.auth-tab', 1), 'register-tab-clicked');
        record(
          (await windowValue('auth', 'document.querySelectorAll(".auth-tab")[1].classList.contains("is-active")')) === true,
          'register-tab-active'
        );
        record(
          (await windowValue('auth', 'document.querySelectorAll(".auth-field[hidden]").length')) === 0,
          'register-tab-fields'
        );
        record(await windowSetAt('auth', '.auth-field input[type="text"]', 0, 'tester@example.com'), 'register-username-typed');
        record(await windowSetValue('auth', '.auth-input-row input[type="password"]', 'pass1234'), 'register-password-typed');
        // 注册 tab 下有两个 password 输入：登录密码（在 .auth-input-row 里）+ 确认密码。
        // 按 index=1 取确认密码：用 .auth-field 选会同时命中「包着登录密码的那个 label」
        record(await windowSetAt('auth', 'input[type="password"]', 1, 'pass1234'), 'register-password2-typed');
        record(await windowClick('auth', '.auth-submit'), 'register-submit-clicked');
        record(await waitWindowClosed('auth', SCENARIO_TIMEOUT_MS), 'register-auto-login');
        record(
          await waitUntil(() => dom['user-name'].textContent === 'tester', 8000),
          'register-nickname-from-backend'
        );
        record(dom.toast && dom.toast.textContent.includes('已创建账号并登录'), 'register-toast');
        record(await waitUntil(() => state.conversations.length === 3, SCENARIO_TIMEOUT_MS), 'claim-list-refreshed');
        // 令牌不再落 localStorage：改查主进程加密文件（saveAuth 已 await，这里读到的就是刚落盘的那份）
        const storedAuth = (await global.desktopBridge.readAuth()) || {};
        record(Boolean(storedAuth.token), 'token-stored');
        record(storedAuth.nickname === 'tester', 'nickname-stored');

        // 3. 退出登录走用户卡片菜单：回未登录态，列表按匿名重拉
        dom['user-card'].click();
        record(dom['user-menu'].hidden === false, 'user-menu-opened');
        dom['btn-logout'].click();
        record(dom['user-name'].textContent === '未登录', 'user-card-after-logout');
        record(await waitUntil(() => state.conversations.length === 0, SCENARIO_TIMEOUT_MS), 'anonymous-list-after-logout');

        // 4. 已注册账号直接密码登录：昵称与头像都来自后端响应
        dom['user-card'].click();
        record(await waitWindowReady('auth', 10000), 'auth-window-opened-again');
        record(await windowSetValue('auth', '.auth-field input[type="text"]', 'tester@example.com'), 'login-username-typed');
        record(await windowSetValue('auth', '.auth-input-row input[type="password"]', 'pass1234'), 'login-password-typed');
        record(await windowClick('auth', '.auth-submit'), 'login-submit-clicked');
        record(await waitWindowClosed('auth', SCENARIO_TIMEOUT_MS), 'password-login-ok');
        record(await waitUntil(() => dom['user-name'].textContent === 'tester', 8000), 'user-card-nickname');
        record(dom['user-avatar'].textContent === 't', 'user-card-avatar');
        record(dom['btn-logout'].hidden === false, 'logout-button-shown');

        // 5. 改昵称：账号不可改、昵称可改，改完立即反映在卡片与落盘记录里
        dom['user-card'].click();
        dom['btn-rename-user'].click();
        record(await waitWindowReady('nickname', 10000), 'nickname-window-opened');
        record(await windowSetValue('nickname', '.modal-card input', '随心用户'), 'nickname-typed');
        record(await windowClick('nickname', '.modal-actions .btn-primary'), 'nickname-saved');
        record(await waitWindowClosed('nickname', SCENARIO_TIMEOUT_MS), 'nickname-window-closed');
        record(await waitUntil(() => dom['user-name'].textContent === '随心用户', SCENARIO_TIMEOUT_MS), 'nickname-updated');
        const renamedAuth = (await global.desktopBridge.readAuth()) || {};
        record(renamedAuth.nickname === '随心用户', 'nickname-persisted');

        // 6. 收尾：停在登录态供自检截图留证（本地令牌在下一场景启动时清理，见段落 16）
        record(dom['user-name'].textContent === '随心用户', 'logged-in-clean');
        record(dom['user-avatar'].textContent === '随', 'avatar-after-rename');
      }

      if (name === 'sessions-view') {
        // 只做「观看态」：加载列表 + 打开第二条会话（含附件卡片），供自检截图留证
        record(await waitUntil(() => state.conversations.length === 2, 8000), 'list-loaded');
        dom['session-list'].querySelectorAll('.session-item')[1].click();
        record(await waitUntil(() => aiBubbles().length > 0, 8000), 'history-loaded');
        record(await waitUntil(() => Boolean(dom['message-list'].querySelector('.attach-card')), 5000), 'attach-card-shown');
        // 会话内搜索：Ctrl+F 打开，命中计数出现
        openChatSearch();
        dom['chat-search-input'].value = '历史';
        runChatSearch('历史');
        record(dom['chat-search'].hidden === false, 'chat-search-open');
        record(/\d+ \/ \d+/.test(dom['chat-search-count'].textContent), 'chat-search-hit');
        closeChatSearch();
        record(dom['chat-search'].hidden === true, 'chat-search-closed');
      }

      if (name === 'sessions') {
        record(await waitUntil(() => state.conversations.length === 2, 8000), 'list-loaded');
        record(dom['session-list'].querySelectorAll('.session-item').length === 2, 'rows-rendered');

        // 搜索：前端按标题过滤（输入 120ms 防抖后重建）
        dom['input-search'].value = '报';
        dom['input-search'].dispatchEvent(new global.Event('input', { bubbles: true }));
        record(
          await waitUntil(() => dom['session-list'].querySelectorAll('.session-item').length === 1, 3000),
          'search-filtered'
        );
        record(Boolean(dom['session-list'].querySelector('.session-title mark')), 'search-highlight');
        record(
          Boolean(dom['session-list'].querySelector('button.session-group-title[aria-expanded]')),
          'group-heading-button'
        );
        dom['input-search'].value = '';
        dom['input-search'].dispatchEvent(new global.Event('input', { bubbles: true }));
        record(
          await waitUntil(() => dom['session-list'].querySelectorAll('.session-item').length === 2, 3000),
          'search-cleared'
        );

        // 切换会话：加载该会话完整历史
        dom['session-list'].querySelectorAll('.session-item')[1].click();
        record(
          await waitUntil(() => aiBubbles().length > 0 && aiBubbles()[0].textContent.includes('历史消息'), 8000),
          'history-loaded'
        );
        record(state.conversationId === 22, 'conversation-switched');
        record(dom['session-list'].querySelectorAll('.session-item.is-active').length === 1, 'active-highlighted');
        record(aiBubbles()[0].querySelectorAll('strong').length > 0, 'history-markdown');

        // 历史附件：文档卡片点开看正文，图片卡片有缩略图
        const docCard = dom['message-list'].querySelector('.attach-card[data-attach-id="91"]');
        record(Boolean(docCard), 'history-attach-card');
        if (docCard) {
          docCard.click();
          record(await waitWindowReady('preview', 10000), 'history-attach-preview');
          record(
            await waitUntilAsync(
              async () => (await windowText('preview', '.preview-body')).includes('本周五上线'),
              8000
            ),
            'history-attach-preview-text'
          );
          record(await windowClick('preview', '#aw-close'), 'preview-close-clicked');
          record(await waitWindowClosed('preview', SCENARIO_TIMEOUT_MS), 'history-attach-preview-closed');
        }
        record(Boolean(dom['message-list'].querySelector('.attach-card[data-attach-id="92"] img')), 'history-image-thumb');

        // 重命名：右键菜单 → 弹窗 → 保存后列表与标题同步
        dom['session-list']
          .querySelectorAll('.session-item')[1]
          .dispatchEvent(new global.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        record(!dom['session-menu'].hidden, 'menu-opened-for-rename');
        dom['session-menu-rename'].click();
        record(await waitWindowReady('rename', 10000), 'rename-window-opened');
        record(await windowSetValue('rename', '.modal-card input', '改过的标题'), 'rename-title-typed');
        record(await windowClick('rename', '.modal-actions .btn-primary'), 'rename-save-clicked');
        record(await waitWindowClosed('rename', SCENARIO_TIMEOUT_MS), 'rename-window-closed');
        record(
          await waitUntil(() => dom['session-list'].textContent.includes('改过的标题'), 5000),
          'rename-reflected'
        );
        record(dom['chat-title'].textContent === '改过的标题', 'rename-title-synced');

        // 草稿：输入不发送，切到别的会话再切回来，文字还在
        const draftConversationId = state.conversationId;
        dom['input-message'].value = '未发送的草稿';
        flushDraft();
        dom['session-list'].querySelectorAll('.session-item')[0].click();
        record(await waitUntil(() => state.conversationId !== draftConversationId, 5000), 'draft-switched-away');
        dom['session-list'].querySelectorAll('.session-item')[1].click();
        record(await waitUntil(() => dom['input-message'].value === '未发送的草稿', 5000), 'draft-restored');
        dom['input-message'].value = '';
        updateComposer();

        // 删除会话：右键菜单 → 二次确认弹窗
        dom['session-list']
          .querySelectorAll('.session-item')[0]
          .dispatchEvent(new global.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        record(!dom['session-menu'].hidden, 'context-menu-opened');
        dom['session-menu-delete'].click();
        record(await waitWindowReady('confirm', 10000), 'confirm-opened');
        record(await windowHas('confirm', '.modal-card-confirm'), 'confirm-card');
        record(await windowClick('confirm', '.settings-foot .btn-danger'), 'confirm-ok-clicked');
        record(await waitUntil(() => state.conversations.length === 1, 8000), 'deleted');
        record(dom['session-list'].querySelectorAll('.session-item').length === 1, 'row-removed');
        record(await waitWindowClosed('confirm', 5000), 'confirm-closed');

        // 新建对话：消息区回到空状态
        dom['btn-new-chat'].click();
        record(state.conversationId === null, 'new-chat-reset');
        record(dom['empty-state'].hidden === false, 'empty-state-back');
      }

      if (name === 'sidebar') {
        // 侧栏：收起 / 展开 / 键盘调宽。鼠标拖拽在冒烟里不稳定，用同一套边界值的键盘路径代替
        const root = document.documentElement;
        const widthOfSidebar = () => document.querySelector('.sidebar').getBoundingClientRect().width;
        record(root.dataset.sidebar === 'expanded', 'sidebar-expanded-by-default');
        dom['btn-sidebar-collapse'].click();
        record(await waitUntil(() => root.dataset.sidebar === 'collapsed', 2000), 'sidebar-collapsed');
        // 动画 240ms，断言别只看某一帧：变量归零或宽度收完都算通过，避免偶发超时
        record(
          await waitUntil(
            () =>
              widthOfSidebar() < 2 ||
              getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim() === '0px',
            3000
          ),
          'sidebar-width-zero'
        );
        record(dom['sidebar-resizer'].tabIndex === -1, 'sidebar-resizer-disabled');
        dom['btn-sidebar-expand'].click();
        record(await waitUntil(() => root.dataset.sidebar === 'expanded', 2000), 'sidebar-expanded-again');
        record(await waitUntil(() => widthOfSidebar() > 150, 2000), 'sidebar-width-restored');
        const key = (name) => new global.KeyboardEvent('keydown', { key: name, bubbles: true });
        dom['sidebar-resizer'].dispatchEvent(key('End'));
        record(await waitUntil(() => widthOfSidebar() >= 340, 2000), 'sidebar-keyboard-max');
        dom['sidebar-resizer'].dispatchEvent(key('Home'));
        record(await waitUntil(() => widthOfSidebar() <= 205, 2000), 'sidebar-keyboard-min');
        // 复位（双击等价）：清掉内联变量，回到断点宽度
        dom['sidebar-resizer'].dispatchEvent(new global.MouseEvent('dblclick', { bubbles: true }));
        record(await waitUntil(() => widthOfSidebar() > 200, 2000), 'sidebar-width-reset');
      }

      if (name === 'enhance') {
        // 1. 主题：先由主进程直接下发菜单动作（menu:action → preload → 页面）切深色；
        //    等主进程注入的真实加速键 Ctrl+Shift+L（1200ms 后）再切回浅色
        record(await waitUntil(() => currentTheme() === THEME_DARK, 6000), 'menu-ipc-toggle-theme');
        record(await waitUntil(() => currentTheme() === THEME_LIGHT, 12000), 'accelerator-toggle-theme');
        record(dom.toast && !dom.toast.hidden && dom.toast.textContent.includes('主题'), 'theme-toast');

        // 2. 接口设置（独立窗口）：非法地址给中文提示且窗口不关；保存只写配置、不自动重连；
        //    「检测连接」才去探后端，检测结果就地显示（见 docs/页面设计规范.md 的 P4 设置）
        dom['btn-settings'].click();
        record(await waitWindowReady('settings', 10000), 'settings-opened');
        // 默认分区是「外观」；接口地址在「连接」分区里，要切过去才操作
        record(
          (await windowValue('settings', 'document.querySelector(".settings-tab.is-active").dataset.pane')) ===
            'appearance',
          'settings-default-appearance'
        );
        record(await windowHas('settings', '.settings-pane[data-pane="appearance"]:not([hidden])'), 'settings-appearance-shown');
        record(await windowHas('settings', '.settings-pane[data-pane="connection"][hidden]'), 'settings-connection-hidden');
        record(await windowClick('settings', '.settings-tab[data-pane="connection"]'), 'settings-connection-clicked');
        record(await windowHas('settings', '.settings-pane[data-pane="connection"]:not([hidden])'), 'settings-connection-shown');
        // 连接状态与「检测连接」都在这个窗口里：主窗口不再背这套 UI
        record(await windowHas('settings', '.settings-pane[data-pane="connection"] .api-status'), 'conn-state-in-settings');
        record(
          await waitUntilAsync(
            async () => (await windowValue('settings', 'document.querySelector(".api-row input").value')) === getConfig().apiBase,
            4000
          ),
          'settings-filled'
        );
        record(await windowSetValue('settings', '.api-row input', '不是地址'), 'settings-invalid-typed');
        record(await windowClickAt('settings', '.api-row button', 0), 'settings-save-invalid');
        record(
          await waitUntilAsync(
            async () => (await windowText('settings', '.settings-pane[data-pane="connection"] .auth-tip')).includes('http://'),
            4000
          ),
          'settings-invalid-tip'
        );
        record(await windowOpen('settings'), 'settings-kept-on-error');
        // 合法地址保存：填「当前生效地址」（端口由总冒烟脚本按空闲口传入，不硬编码端口、不依赖用户配置里的旧值）
        const savedBase = getConfig().apiBase;
        record(await windowSetValue('settings', '.api-row input', savedBase), 'settings-valid-typed');
        record(await windowClickAt('settings', '.api-row button', 0), 'settings-save-valid');
        record(await waitUntil(() => getConfig().apiBase === savedBase, 4000), 'settings-applied');
        record(await windowOpen('settings'), 'settings-stay-open-on-save');
        record(await windowClickAt('settings', '.api-row button', 1), 'settings-check-clicked');
        record(await waitWindowHas('settings', '.api-status.is-ok', 10000), 'api-check-ok');
        record(await windowClick('settings', '.settings-foot .btn-primary'), 'settings-done-clicked');
        record(await waitWindowClosed('settings', 5000), 'settings-closed-by-done');
        record(await waitUntil(() => state.online === true, 8000), 'reconnect-after-check');

        // 3. 附件：选文件（冒烟由主进程注入路径，不弹窗）→ 附件条显示名称/大小/缩略图 → 发送走 /chat_upload
        await pickAttachment();
        const firstAttach = state.attachments[0];
        record(Boolean(firstAttach) && firstAttach.name.length > 0, 'attach-picked');
        record(dom['attach-bar'].hidden === false, 'attach-bar-shown');
        const attachChip = dom['attach-bar'].querySelector('.attach-item');
        record(
          Boolean(attachChip) && attachChip.querySelector('.attach-name').textContent === firstAttach.name,
          'attach-name-shown'
        );
        record(Boolean(attachChip) && attachChip.querySelector('.attach-size').textContent !== '0 B', 'attach-size-shown');
        record(Boolean(attachChip && attachChip.querySelector('.attach-thumb')), 'attach-thumb-shown');
        record((await sendMessage('看看这张图')) === true, 'attach-send-accepted');
        record(await waitUntil(() => state.generating === false, 15000), 'attach-chat-finished');
        record(dom['attach-bar'].hidden === true, 'attach-cleared');
        // 附件不再是一行 `[上传文件]` 文本，而是可点开的卡片：缩略图 + 点击进灯箱
        const attachCard = dom['message-list'].querySelector('.msg-row.is-user .attach-card');
        record(Boolean(attachCard), 'attach-card-rendered');
        record(Boolean(attachCard && attachCard.querySelector('.attach-card-thumb')), 'attach-card-thumb');
        if (attachCard) {
          attachCard.click();
          record(await waitWindowReady('lightbox', 10000), 'lightbox-opened');
          record(
            await waitUntilAsync(
              async () =>
                Boolean(
                  await windowValue('lightbox', 'document.querySelector(".lightbox-image").getAttribute("src")')
                ),
              8000
            ),
            'lightbox-image-loaded'
          );
          record(await windowClick('lightbox', '#aw-close'), 'lightbox-close-clicked');
          record(await waitWindowClosed('lightbox', 5000), 'lightbox-closed');
        }

        // 4. 导出 Markdown：走菜单动作 export-chat（冒烟由主进程写入注入路径，不弹保存框）
        handleMenuAction('export-chat');
        record(await waitUntil(() => dom.toast && dom.toast.textContent.includes('已导出'), 8000), 'export-done');

        // 5. 对话历史：独立窗口（内容在窗口里，主窗口侧只验证窗口确实被建起来了；
        //    窗口内是否挂载成功由主进程的 child-windows 自检兜底）
        dom['btn-memory'].click();
        record(await waitWindowReady('memory', SCENARIO_TIMEOUT_MS), 'memory-window-opened');
        record(
          await waitUntilAsync(
            async () =>
              (await windowValue('memory', 'document.getElementById("aw-title").textContent')) ===
              dom['chat-title'].textContent,
            4000
          ),
          'memory-title-synced'
        );

        // 6. 快捷键动作「新对话」同一入口：清屏回空状态
        handleMenuAction('new-chat');
        record(state.conversationId === null, 'menu-new-chat');
        record(dom['empty-state'].hidden === false, 'menu-new-chat-empty');
      }

      if (name === 'enhance-view') {
        // 只做「观看态」：打开一个会话 → 记忆窗口 → 设置窗口 → 模型窗口，供自检截图留证
        record(await waitUntil(() => state.conversations.length === 2, 8000), 'list-loaded');
        dom['session-list'].querySelectorAll('.session-item')[0].click();
        record(await waitUntil(() => aiBubbles().length > 0, 8000), 'history-loaded');
        dom['btn-memory'].click();
        record(await waitWindowReady('memory', SCENARIO_TIMEOUT_MS), 'memory-window-opened');
        dom['btn-settings'].click();
        record(await waitWindowReady('settings', 10000), 'settings-opened');
        // 模型分区：模型控件在设置窗口里，入口存在、窗口能开能关
        record(await windowClick('settings', '.settings-tab[data-pane="models"]'), 'model-pane-clicked');
        record(await windowHas('settings', '.settings-pane[data-pane="models"]:not([hidden])'), 'model-pane-shown');
        record(await windowClick('settings', '.settings-pane[data-pane="models"] .storage-actions .btn-ghost'), 'model-add-clicked');
        record(await waitWindowReady('model', 10000), 'model-window-opened');
        record(
          (await windowValue('model', 'document.querySelector(".db-grid select").value')) === 'deepseek',
          'model-preset-default'
        );
        record(await windowClick('model', '.modal-actions .btn-ghost'), 'model-cancel-clicked');
        record(await waitWindowClosed('model', 5000), 'model-window-closed');
      }

      if (name === 'prompt') {
        // 扩展性验收：新增窗口只做两件事（注册表加一条 + 写自己的视图），
        // 标题栏 / 主题跟随 / Esc 关闭 / 入口都必须自动成立
        record(
          await waitUntil(() => Boolean(document.querySelector('#more-menu [data-more="window:prompt"]')), 4000),
          'prompt-menu-entry'
        );
        const openedPrompt = await bridge.openWindow('prompt', {});
        record(Boolean(openedPrompt && openedPrompt.ok), 'prompt-window-opened');
        record(await waitWindowReady('prompt', 10000), 'prompt-mounted');
        record(
          (await windowValue('prompt', 'document.getElementById("aw-title").textContent')) === '提示词库',
          'prompt-title'
        );
        record(
          (await windowValue('prompt', 'document.documentElement.dataset.theme')) === currentTheme(),
          'prompt-theme-follows'
        );
        record(await windowHas('prompt', '.prompt-item'), 'prompt-defaults');
        await windowEscape('prompt');
        record(await waitWindowClosed('prompt', 4000), 'prompt-closed-by-esc');
      }

      if (name === 'restore') {
        // 恢复入口只看「窗口能开、选到包后路径回填、Esc 只关它自己」：
        // 真正执行恢复是整库写入，冒烟用的是假后端，不该真跑
        dom['btn-settings'].click();
        record(await waitWindowReady('settings', 10000), 'settings-opened');
        // 「从备份恢复」在「数据与备份」分区：先切过去
        record(await windowClick('settings', '.settings-tab[data-pane="storage"]'), 'storage-pane-clicked');
        record(
          await windowHas('settings', '.settings-pane[data-pane="storage"]:not([hidden])'),
          'storage-pane-shown'
        );
        record(
          await windowValue(
            'settings',
            '(() => { const b = Array.from(document.querySelectorAll(".settings-pane[data-pane=\\"storage\\"] button")).find((el) => el.textContent.trim() === "选择文件"); if (!b) return false; b.click(); return true; })()'
          ),
          'restore-entry-clicked'
        );
        record(await waitWindowReady('restore', 10000), 'restore-opened');
        record(
          (await windowValue('restore', 'document.querySelector(".modal-actions .btn-primary").disabled')) === true,
          'restore-ok-disabled-before-pick'
        );
        // 历史产物候选：要么列出记录，要么明确说「还没有」。两者同时隐藏 = 渲染没跑
        record(
          await waitUntilAsync(async () => {
            const rendered = await windowValue(
              'restore',
              '(() => { const list = document.querySelector(".restore-picks"); const empty = document.querySelector(".restore-picks-block .settings-hint"); return Boolean((list && !list.hidden) || (empty && !empty.hidden)); })()'
            );
            return rendered === true;
          }, 5000),
          'restore-picks-rendered'
        );
        // 主进程的选文件对话框在冒烟里由 SMOKE_RESTORE_FILE 注入
        record(await windowClickAt('restore', '.path-row button', 0), 'restore-pick-clicked');
        record(
          await waitUntilAsync(
            async () => (await windowValue('restore', 'document.querySelector(".path-row input").value.length')) > 0,
            5000
          ),
          'restore-path-filled'
        );
        record(
          (await windowValue('restore', 'document.querySelector(".modal-actions .btn-primary").disabled')) === false,
          'restore-ok-enabled-after-pick'
        );
        // Esc 只关最上面这扇：恢复窗口关掉，底下的设置窗口必须原样还在
        await windowEscape('restore');
        record(await waitWindowClosed('restore', 4000), 'restore-closed-by-esc');
        record(await windowOpen('settings'), 'settings-kept-under');
      }

      if (name === 'rounds') {
        // 连续 10 轮（第 2 条的桌面端链路证据）：每轮发一条 → 等本轮生成结束 → 断言回复非空、无错误气泡、会话不漂移
        const rounds = 10;
        let completed = 0;
        for (let index = 1; index <= rounds; index += 1) {
          // sendMessage 内部 await 整条流，返回时本轮已生成结束；返回 false = 被拦截或后端不在线
          const accepted = await sendMessage(`第 ${index} 轮：请回一句话`);
          if (!accepted) {
            break;
          }
          const bubble = aiBubbles()[index - 1];
          if (!bubble || bubble.textContent.length === 0) {
            break;
          }
          completed = index;
        }
        record(completed === rounds, `rounds-completed=${completed}/${rounds}`);
        record(aiBubbles().length === rounds, 'rounds-bubbles');
        record(!dom['message-list'].querySelector('.msg-row.is-error'), 'rounds-no-error');
        record(dom['message-list'].querySelectorAll('.cursor').length === 0, 'rounds-no-cursor');
        record(state.conversationId === 12, 'rounds-conversation-stable');
        record(!dom['btn-send'].classList.contains('is-stop'), 'rounds-send-restored');
      }

      return {
        scenario: name,
        failures,
        notes,
        online: state.online,
        models: state.models.length,
        conversationId: state.conversationId
      };
    }

    return { smokeReport, runSmokeScenario };
  }

  /**
   * 挂上自检入口：只有 app.js 在检测到 smoke=1（主进程 --smoke 才会带）时调用。
   * 正常启动的页面不执行这里，window 上不会出现任何可被脚本驱动的测试入口。
   */
  function mount(deps) {
    const api = createSmokeApi(deps || {});
    global.__smokeReport = api.smokeReport;
    global.__smokeScenario = api.runSmokeScenario;
    return api;
  }

  const api = { mount, createSmokeApi };
  // 双出口：浏览器里挂 window.SXWSmoke，单测里走 module.exports
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SXWSmoke = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
