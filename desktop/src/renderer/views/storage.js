/**
 * 文件：desktop/src/renderer/views/storage.js
 * 职责：切换存储窗口——目标卡（SQLite / MySQL）+ MySQL 连接表单 + 测试连接 + 确认后重启后端。
 * 载荷：{ backend, connection }（缺省时自己问主进程 backendStatus）
 * 口径：校验规则与主进程 sanitizeStorageForm 一致；远程地址必须显式勾选同意。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const DB_LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

  window.SXW_VIEWS.storage = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const payload = ctx.payload || {};
      let current = payload.backend || '';
      let connection = payload.connection || null;
      let target = '';
      let busy = false;

      const targets = [
        { id: 'sqlite', name: '本机 SQLite', desc: '单文件数据库，跟着应用走，换机器拷走即可' },
        { id: 'mysql', name: 'MySQL', desc: '可本机可远程，适合多人或多端共用一份数据' }
      ];

      const targetButtons = targets.map((item) =>
        h('button', {
          class: 'storage-target',
          type: 'button',
          dataset: { target: item.id },
          onclick: () => select(item.id)
        }, [h('b', { text: item.name }), h('span', { text: item.desc })])
      );

      const host = h('input', { class: 'auth-input', type: 'text', placeholder: '127.0.0.1', autocomplete: 'off' });
      const port = h('input', { class: 'auth-input', type: 'text', placeholder: '3306', autocomplete: 'off' });
      const user = h('input', { class: 'auth-input', type: 'text', placeholder: 'root', autocomplete: 'off' });
      const password = h('input', { class: 'auth-input', type: 'password', autocomplete: 'off' });
      const dbName = h('input', { class: 'auth-input', type: 'text', placeholder: 'suixinwenda', autocomplete: 'off' });
      const sslCa = h('input', {
        class: 'auth-input',
        type: 'text',
        placeholder: '可选：CA 的 .pem 路径（填了就走 TLS）',
        autocomplete: 'off'
      });
      const allowRemote = h('input', { type: 'checkbox' });
      const dbTip = h('p', { class: 'auth-tip', hidden: true });
      const testButton = h('button', { class: 'btn-ghost', type: 'button', text: '测试连接' });
      const storageTip = h('p', { class: 'auth-tip', hidden: true });
      const cancelButton = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const okButton = h('button', { class: 'btn-primary', type: 'button', text: '切换' });
      const footHint = h('span', { class: 'settings-foot-hint', text: '密码加密保存在本机，永不回显' });

      function field(label, input) {
        return h('label', { class: 'auth-field' }, [h('span', { class: 'auth-label', text: label }), input]);
      }

      const dbBlock = h('div', { class: 'db-block', hidden: true }, [
        h('div', { class: 'db-grid' }, [
          field('主机', host),
          field('端口', port),
          field('用户名', user),
          field('密码', password),
          field('库名', dbName),
          field('CA 证书', sslCa)
        ]),
        h('label', { class: 'restore-check' }, [
          allowRemote,
          h('span', { text: '允许连接远程数据库（聊天记录会离开本机，建议同时配置 CA 走 TLS）' })
        ]),
        dbTip,
        h('div', { class: 'storage-actions' }, [testButton])
      ]);

      root.appendChild(
        h('div', { class: 'modal-card modal-card-520', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { class: 'settings-head' }, [
            h('div', { class: 'settings-head-text' }, [
              // 窗口名已在标题栏：这里只说明代价，不再重复窗口名
              h('p', { class: 'settings-sub', text: '切换后后端会重启一次，会话列表重新读取' })
            ])
          ]),
          h('div', { class: 'storage-body' }, [
            h('p', { class: 'settings-hint', text: '目标存储' }),
            h('div', { class: 'storage-targets', role: 'group', 'aria-label': '目标存储' }, targetButtons),
            dbBlock,
            storageTip
          ]),
          h('div', { class: 'settings-foot' }, [footHint, h('span', { class: 'grow' }), cancelButton, okButton])
        ])
      );

      function setTip(element, text, isError) {
        element.textContent = text || '';
        element.hidden = !text;
        element.classList.toggle('is-error', Boolean(text) && Boolean(isError));
      }

      function select(next) {
        target = next;
        targetButtons.forEach((button) => {
          button.classList.toggle('is-active', button.dataset.target === next);
        });
        dbBlock.hidden = next !== 'mysql';
        if (next === 'mysql') {
          applyConnection();
        }
        setTip(storageTip, '');
        setTip(dbTip, '');
      }

      /** 用「当前真正生效的连接」覆盖表单：否则按旧值测试会连到早就换掉的库。 */
      function applyConnection() {
        if (connection && connection.host) {
          host.value = connection.host;
          port.value = connection.port || '3306';
          user.value = connection.user || '';
          dbName.value = connection.name || '';
        } else {
          if (!host.value) {
            host.value = '127.0.0.1';
          }
          if (!port.value) {
            port.value = '3306';
          }
          if (!user.value) {
            user.value = 'root';
          }
          if (!dbName.value) {
            dbName.value = 'suixinwenda';
          }
        }
        password.value = '';
        sslCa.value = '';
      }

      function readForm() {
        return {
          DB_HOST: host.value.trim(),
          DB_PORT: port.value.trim(),
          DB_USER: user.value.trim(),
          DB_PASSWORD: password.value,
          DB_NAME: dbName.value.trim(),
          DB_ALLOW_REMOTE: allowRemote.checked ? '1' : '',
          DB_SSL_CA: sslCa.value.trim()
        };
      }

      function validate(form) {
        if (!form.DB_HOST || /\s/.test(form.DB_HOST)) {
          return '主机不能为空，也不能包含空白字符';
        }
        if (!/^\d+$/.test(form.DB_PORT) || Number(form.DB_PORT) < 1 || Number(form.DB_PORT) > 65535) {
          return '端口必须是 1-65535 之间的整数';
        }
        if (!form.DB_USER) {
          return '用户名不能为空';
        }
        if (!form.DB_PASSWORD.trim()) {
          return '密码不能为空：后端的数据库连接必须带密码（本机 MySQL 是空密码时请先设一个）';
        }
        if (!form.DB_NAME) {
          return '库名不能为空';
        }
        if (!DB_LOCAL_HOSTS.includes(form.DB_HOST.toLowerCase()) && form.DB_ALLOW_REMOTE !== '1') {
          return '这是远程地址：请先勾选「允许连接远程数据库」';
        }
        return '';
      }

      testButton.addEventListener('click', async () => {
        const form = readForm();
        const invalid = validate(form);
        if (invalid) {
          setTip(dbTip, invalid, true);
          return;
        }
        setTip(dbTip, '正在连接…', false);
        const result = await ctx.bridge.testStorage(form);
        if (!result || !result.ok) {
          setTip(dbTip, (result && result.error) || '连接失败', true);
          return;
        }
        let message = `连接成功（MySQL ${result.version || '版本未知'}）`;
        if (result.empty === true) {
          message += '，库里还没有会话数据';
        } else if (result.empty === false) {
          message += `，目标库已有 ${Number(result.rows) || 0} 个会话，切换后列表会显示这些数据`;
        }
        if (result.remote) {
          message += '。注意：这是远程库，聊天记录会保存在那台机器上';
        }
        setTip(dbTip, message, false);
      });

      function setBusy(next) {
        busy = next;
        okButton.disabled = next;
        cancelButton.disabled = next;
        testButton.disabled = next;
        targetButtons.forEach((button) => {
          button.disabled = next;
        });
        ctx.setClosable(!next);
      }

      async function restart(patch) {
        setBusy(true);
        setTip(storageTip, '正在切换存储，后端重启中…', false);
        try {
          const result = await ctx.bridge.restartBackend(patch);
          if (!result || !result.ok) {
            setTip(storageTip, (result && result.error) || '切换失败，已回到原存储', true);
            return;
          }
          ctx.result({ action: 'switched', backend: target });
          // 先解除不可关闭：busy 期间主进程会拦下 close，窗口留在原地并弹「不能关闭」
          setBusy(false);
          ctx.close();
        } catch (error) {
          setTip(storageTip, (error && error.message) || '切换失败，已回到原存储', true);
        } finally {
          setBusy(false);
        }
      }

      // 确认框由本窗口打开，结果回到本窗口（app-windows 的 opener 路由）。
      // 按窗口 id 存 patch：同时开两个确认框时，单槽位会让「确认第一个」执行第二个的目标库，
      // 用户可能在本机与远程之间被悄悄切反
      const pendingPatches = new Map();
      // 视图可能被整块重挂（pushWindow / 再次打开）：监听不解绑会叠加，
      // 一次回包触发多次 restart，旧闭包还会去改已脱离文档的节点
      const unsubscribes = [];
      function track(unsubscribe) {
        if (typeof unsubscribe === 'function') {
          unsubscribes.push(unsubscribe);
        }
      }

      track(
        ctx.bridge.onReply((packet) => {
          if (!packet || packet.from !== 'confirm') {
            return;
          }
          const action = packet.data && packet.data.action;
          if (action !== 'confirm') {
            return;
          }
          const patch = pendingPatches.get(packet.windowId);
          pendingPatches.delete(packet.windowId);
          if (patch) {
            restart(patch);
          }
        })
      );
      // 确认框被直接关掉时不会回包，凭 id 清掉对应 patch，避免长期持有
      if (typeof ctx.bridge.onWindowClosed === 'function') {
        track(
          ctx.bridge.onWindowClosed((packet) => {
            if (packet && packet.windowId) {
              pendingPatches.delete(packet.windowId);
            }
          })
        );
      }

      okButton.addEventListener('click', async () => {
        if (busy) {
          return;
        }
        if (!target) {
          setTip(storageTip, '请先选择目标存储', true);
          return;
        }
        if (target === current) {
          setTip(storageTip, '当前已经在这个存储上，不需要切换', true);
          return;
        }
        const targetLabel = target === 'sqlite' ? '本机 SQLite' : 'MySQL';
        let patch = { DB_BACKEND: target };
        if (target === 'mysql') {
          const form = readForm();
          const invalid = validate(form);
          if (invalid) {
            setTip(dbTip, invalid, true);
            return;
          }
          patch = { DB_BACKEND: target, ...form };
        }
        const remoteTarget = target === 'mysql' && !DB_LOCAL_HOSTS.includes(String(patch.DB_HOST || '').toLowerCase());
        const text =
          target === 'sqlite'
            ? '切换后看到的是一个空库：MySQL 里的会话不会搬过去，也不会被删除，切回 MySQL 就能回到现在的状态。建议先备份。'
            : remoteTarget
              ? '目标是一个远程数据库：聊天记录会保存在那台机器上。附件仍然只在本机，换一台电脑连同一个库看不到附件。切换后看到的是该库自己的数据。建议先备份。'
              : '切回后会看到原来那份 MySQL 数据；SQLite 里当前的会话不会搬过去，也不会被删除。建议先备份。';
        setTip(storageTip, '');
        const opened = await ctx.openWindow('confirm', {
          title: `切换到${targetLabel}`,
          text,
          okText: '开始切换',
          note: '切换期间不能关闭应用，后端会重启一次'
        });
        if (opened && opened.ok) {
          pendingPatches.set(opened.id, patch);
        } else {
          setTip(storageTip, (opened && opened.error) || '无法打开确认窗口，请重试', true);
        }
      });

      cancelButton.addEventListener('click', () => ctx.close());

      // 初始状态：默认选中「另一个」（打开的目的几乎总是想换过去）
      async function init() {
        if (!current || !connection) {
          const status = (await ctx.bridge.backendStatus()) || {};
          current = status.backend || current;
          connection = status.connection || connection;
        }
        // 用户可能在 backendStatus 返回前就点选了目标：不能把选择覆盖回默认项
        if (!target) {
          select(current === 'mysql' ? 'sqlite' : 'mysql');
        }
      }
      init();

      return {
        // 切换中不接受新载荷；空闲时交给外壳重挂（重新按当前后端初始化目标卡）
        onPayload() {
          return busy;
        },
        onEscape() {
          if (busy) {
            ctx.toast('正在切换存储，完成前不能关闭这个窗口', 'error');
            return true;
          }
          ctx.close();
          return true;
        },
        destroy() {
          unsubscribes.forEach((unsubscribe) => {
            try {
              unsubscribe();
            } catch (error) {
              console.error('[存储] 取消订阅失败', error);
            }
          });
          unsubscribes.length = 0;
          pendingPatches.clear();
        }
      };
    }
  };
})();
