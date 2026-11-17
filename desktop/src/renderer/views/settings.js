/**
 * 文件：desktop/src/renderer/views/settings.js
 * 职责：设置窗口——外观 / 连接 / 数据与备份 / 模型 / 关于五个分区。
 *      子窗口（切换存储、保存、恢复、模型编辑、确认框）一律经 ctx.openWindow 打开，
 *      结果通过 app-window:reply 回到本窗口（见 app-windows.js 的 opener 路由）。
 * 口径：地址白名单、产物动作、模型校验、危险操作确认都与原实现一致。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const API_BASE_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
  const CONNECT_TIMEOUT = 3000;
  const MODELS_TIMEOUT = 8000;
  const CLEAN_OLD_DAYS = 30;
  const VERSION = '0.1.0';

  const PANES = [
    { id: 'appearance', label: '外观' },
    { id: 'connection', label: '连接' },
    { id: 'storage', label: '数据与备份' },
    { id: 'models', label: '模型' },
    { id: 'about', label: '关于' }
  ];

  window.SXW_VIEWS.settings = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const { bridge } = ctx;
      const state = {
        config: {},
        storageBackend: '',
        connection: null,
        artifacts: [],
        models: { models: [], default: '' },
        presets: [],
        checks: {}
      };

      // ---------- 骨架 ----------
      const nav = h('nav', { class: 'settings-nav', 'aria-label': '设置分区' });
      const panes = h('div', { class: 'settings-panes' });
      const tabButtons = new Map();
      const paneSections = new Map();

      PANES.forEach((pane) => {
        const button = h('button', { class: 'settings-tab', type: 'button', dataset: { pane: pane.id } }, [
          h('span', { text: pane.label })
        ]);
        button.addEventListener('click', () => activate(pane.id));
        tabButtons.set(pane.id, button);
        nav.appendChild(button);

        const section = h('section', { class: 'settings-pane', dataset: { pane: pane.id }, hidden: true });
        paneSections.set(pane.id, section);
        panes.appendChild(section);
      });

      const footHint = h('span', { class: 'settings-foot-hint', text: '当前存储：读取中…' });
      const doneButton = h('button', { class: 'btn-primary', type: 'button', text: '完成' });
      doneButton.addEventListener('click', () => ctx.close());

      root.appendChild(
        h('div', { class: 'modal-card modal-card-settings', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { class: 'settings-head' }, [
            h('div', { class: 'settings-head-text' }, [
              // 窗口名已在标题栏，卡片里不再重复一遍，只留这句说明
              h('p', {
                class: 'settings-sub',
                text: '外观与自动备份改动即时生效 · 接口地址在「连接」里单独保存'
              })
            ])
          ]),
          h('div', { class: 'settings-body' }, [nav, panes]),
          h('div', { class: 'settings-foot' }, [footHint, h('span', { class: 'grow' }), doneButton])
        ])
      );

      function activate(id) {
        tabButtons.forEach((button, key) => button.classList.toggle('is-active', key === id));
        paneSections.forEach((section, key) => {
          section.hidden = key !== id;
        });
        // 切到对应分区时现读一次：后端可能刚被切过或被外部重启过
        if (id === 'storage') {
          refreshStorage();
          refreshArtifacts();
        }
        if (id === 'models') {
          refreshModels();
        }
      }

      // ---------- 外观 ----------
      const themeChoices = [
        { id: 'light', name: '浅色', desc: '纯白画布', cls: 'theme-swatch-light' },
        { id: 'dark', name: '深色', desc: '墨岩石墨', cls: 'theme-swatch-dark' }
      ];
      const themeButtons = themeChoices.map((item) =>
        h(
          'button',
          {
            class: 'theme-choice',
            type: 'button',
            dataset: { themeChoice: item.id },
            onclick: () => chooseTheme(item.id)
          },
          [
            h('span', { class: `theme-swatch ${item.cls}`, 'aria-hidden': 'true' }),
            h('span', { class: 'theme-choice-name', text: item.name }),
            h('span', { class: 'theme-choice-desc', text: item.desc })
          ]
        )
      );

      const fontChoices = [
        { id: 'small', name: '小', desc: '一屏更多' },
        { id: 'normal', name: '标准', desc: '默认' },
        { id: 'large', name: '大', desc: '更易读' }
      ];
      const fontButtons = fontChoices.map((item) =>
        h(
          'button',
          {
            class: 'theme-choice',
            type: 'button',
            dataset: { fontChoice: item.id },
            onclick: () => chooseFont(item.id)
          },
          [
            h('span', { class: `font-swatch is-${item.id}`, 'aria-hidden': 'true', text: 'A' }),
            h('span', { class: 'theme-choice-name', text: item.name }),
            h('span', { class: 'theme-choice-desc', text: item.desc })
          ]
        )
      );

      paneSections.get('appearance').append(
        h('p', {
          class: 'settings-hint',
          text: '深浅两套主题共用一套底色逻辑：深色为墨岩石墨分层，浅色为纯白画布，强调色统一为品牌青绿。'
        }),
        h('div', { class: 'theme-choices' }, themeButtons),
        h('p', { class: 'settings-hint', text: '正文字号只影响消息与输入区，侧栏和按钮尺寸保持不变。' }),
        h('div', { class: 'theme-choices', role: 'group', 'aria-label': '正文字号' }, fontButtons)
      );

      async function chooseTheme(theme) {
        if (theme === state.config.theme) {
          return;
        }
        // 主进程写盘后会广播 app:config-changed，所有窗口（含本窗口）据此更新选中态
        await bridge.writeConfig({ theme });
        ctx.toast(theme === 'dark' ? '已切换为深色主题' : '已切换为浅色主题');
      }

      async function chooseFont(scale) {
        if (scale === state.config.fontScale) {
          return;
        }
        await bridge.writeConfig({ fontScale: scale });
        ctx.toast(scale === 'normal' ? '已恢复标准字号' : '字号已调整');
      }

      function syncAppearance() {
        themeButtons.forEach((button) => {
          button.classList.toggle('is-active', button.dataset.themeChoice === state.config.theme);
        });
        fontButtons.forEach((button) => {
          button.classList.toggle('is-active', button.dataset.fontChoice === (state.config.fontScale || 'normal'));
        });
      }

      // ---------- 连接 ----------
      const apiInput = h('input', {
        class: 'auth-input api-input',
        type: 'text',
        placeholder: 'http://127.0.0.1:8010',
        'aria-label': '接口地址'
      });
      const apiSave = h('button', { class: 'btn-ghost', type: 'button', text: '保存' });
      const apiCheck = h('button', { class: 'btn-ghost', type: 'button', text: '检测连接' });
      const apiStatusText = h('span', { text: '未检测' });
      const apiStatus = h('p', { class: 'api-status is-idle' }, [
        h('span', { class: 'api-dot', 'aria-hidden': 'true' }),
        apiStatusText
      ]);
      const settingsTip = h('p', { class: 'auth-tip', hidden: true });

      paneSections.get('connection').append(
        h('p', {
          class: 'settings-hint',
          text: '后端接口地址：只接受本机回环地址。保存只写配置，检测才真正连一次后端。'
        }),
        h('div', { class: 'api-row' }, [apiInput, apiSave, apiCheck]),
        apiStatus,
        settingsTip,
        h('div', { class: 'settings-panel' }, [
          h('p', { class: 'settings-panel-title', text: '检测失败时（就地显示，不弹提示条）' }),
          h('p', {
            class: 'settings-hint',
            text: '红点 + 一句话原因，例如「后端未启动 · 检查 http://127.0.0.1:8010 是否有服务在运行」。地址只接受 http://127.0.0.1 或 http://localhost（可带端口），其它地址会被主进程丢弃。'
          })
        ])
      );

      function setSettingsTip(text, isError) {
        settingsTip.textContent = text || '';
        settingsTip.hidden = !text;
        settingsTip.classList.toggle('is-error', Boolean(text) && Boolean(isError));
      }

      function setApiStatus(cls, text) {
        apiStatus.className = `api-status ${cls}`;
        apiStatusText.textContent = text;
      }

      apiSave.addEventListener('click', async () => {
        const raw = apiInput.value.trim().replace(/\/+$/, '');
        if (!API_BASE_PATTERN.test(raw)) {
          setSettingsTip('只支持 http://127.0.0.1 或 http://localhost 这样的本机地址，例如 http://127.0.0.1:8010', true);
          return;
        }
        // 以主进程返回的配置为准：被白名单丢弃的地址不会落盘，界面也就不会假报「已保存」
        const saved = await bridge.writeConfig({ apiBase: raw });
        if (!saved || saved.apiBase !== raw) {
          setSettingsTip('这个地址不被接受（只支持本机 http 地址），已保留原来的设置', true);
          setApiStatus('is-err', '地址被拒绝，仍是原来的设置');
          return;
        }
        state.config.apiBase = saved.apiBase;
        setSettingsTip('');
        setApiStatus('is-idle', '已保存，尚未检测');
        ctx.toast('接口地址已保存');
      });

      apiCheck.addEventListener('click', async () => {
        const raw = apiInput.value.trim().replace(/\/+$/, '');
        if (!API_BASE_PATTERN.test(raw)) {
          setSettingsTip('只支持 http://127.0.0.1 或 http://localhost 这样的本机地址，例如 http://127.0.0.1:8010', true);
          setApiStatus('is-err', '地址格式不对');
          return;
        }
        if (raw !== state.config.apiBase) {
          setSettingsTip('输入框里的地址还没保存：本次检测仍会连已保存的地址，保存后再点一次才是新地址', true);
        } else {
          setSettingsTip('');
        }
        setApiStatus('is-idle', '检测中…');
        let online = false;
        let modelCount = 0;
        try {
          const body = await ctx.kit.requestJson('/health', { timeout: CONNECT_TIMEOUT });
          const payload = ctx.kit.jsonPayload(body);
          online = Boolean((payload && payload.code === 0) || (body && body.code === 0));
        } catch (error) {
          online = false;
        }
        if (online) {
          try {
            const listed = await ctx.kit.requestJson('/get_models', { timeout: MODELS_TIMEOUT });
            const payload = ctx.kit.jsonPayload(listed) || {};
            const models = Array.isArray(payload.models) ? payload.models : Array.isArray(payload) ? payload : [];
            modelCount = models.length;
          } catch (error) {
            modelCount = 0;
          }
          setApiStatus('is-ok', `已连接 · ${modelCount} 个模型`);
        } else {
          setApiStatus('is-err', '连接失败，确认后端已启动');
        }
      });

      // ---------- 数据与备份 ----------
      const storageCurrent = h('b', { text: '读取中…' });
      const storageDetail = h('span', { text: '读取中…' });
      const storagePill = h('span', { class: 'pill-state', text: '本机数据' });
      const switchStorage = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: '切换存储…', disabled: true });
      const autoEnabled = h('input', { type: 'checkbox', checked: true });
      const autoDays = h('input', { class: 'auth-input', type: 'number', min: 1, max: 90, step: 1, value: 7 });
      const autoTip = h('p', { class: 'settings-hint', hidden: true });
      const artifactList = h('ul', { class: 'artifact-list', hidden: true });
      const artifactEmpty = h('p', { class: 'settings-hint', text: '还没有备份或导出。' });
      const backupButton = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: '开始备份' });
      const exportButton = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: '导出' });
      const restoreButton = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: '选择文件' });
      const cleanButton = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: `清理 ${CLEAN_OLD_DAYS} 天前的产物` });
      const purgeButton = h('button', { class: 'btn-danger btn-sm', type: 'button', text: '清除…' });

      function row(main, ...controls) {
        return h('div', { class: 'set-row' }, [h('span', { class: 'set-row-main' }, main), ...controls]);
      }

      paneSections.get('storage').append(
        h('div', { class: 'settings-panel' }, [
          h('p', { class: 'settings-panel-title', text: '数据存在哪里' }),
          h('div', { class: 'set-row is-first' }, [
            h('span', { class: 'set-row-main' }, [
              h('b', { text: '本机 SQLite（默认）' }),
              h('span', { text: '会话、消息、摘要与附件全部保存在这台电脑上，不经过任何服务器' })
            ])
          ]),
          row([
            h('b', { text: '切换到 MySQL 时' }),
            h('span', {
              text: '数据写入你指定的数据库；如果那是一台远程服务器，聊天记录与附件会离开本机，请确认你信任它，并建议在「SSL CA」里配置证书加密传输'
            })
          ]),
          row([
            h('b', { text: '始终留在本机的' }),
            h('span', { text: '模型 API Key（系统级加密）、全部设置与备份文件；提问内容只发送给你配置的模型服务' })
          ])
        ]),
        h('div', { class: 'settings-panel' }, [
          h('p', { class: 'settings-panel-title', text: '当前存储' }),
          h('div', { class: 'set-row is-first' }, [
            h('span', { class: 'set-row-main' }, [storageCurrent, storageDetail]),
            storagePill,
            switchStorage
          ])
        ]),
        h('div', { class: 'settings-panel' }, [
          h('p', { class: 'settings-panel-title', text: '自动备份' }),
          h('div', { class: 'set-row is-first' }, [
            h('span', { class: 'set-row-main' }, [
              h('b', { text: '定期自动备份' }),
              h('span', { text: '每次启动时检查，超过间隔天数就在后台静默备份，单独保留最近 5 份' })
            ]),
            h('label', { class: 'sw-tgl' }, [autoEnabled, h('span', { class: 'sw-knob', 'aria-hidden': 'true' })]),
            h('label', { class: 'set-days' }, [autoDays, h('span', { text: '天' })])
          ]),
          autoTip
        ]),
        h('div', { class: 'settings-panel' }, [
          h('p', { class: 'settings-panel-title', text: '备份与导出' }),
          h('div', { class: 'set-row is-first' }, [
            h('span', { class: 'set-row-main' }, [h('b', { text: '立即备份' }), h('span', { text: '数据库快照 + 附件，单个 zip' })]),
            backupButton
          ]),
          row([h('b', { text: '导出数据' }), h('span', { text: '整库业务表，不含附件原文件' })], exportButton),
          row([h('b', { text: '从备份恢复' }), h('span', { text: '支持 zip 与导出目录，可补附件来源' })], restoreButton)
        ]),
        h('div', { class: 'settings-panel' }, [
          h('p', { class: 'settings-panel-title', text: '备份产物' }),
          artifactList,
          artifactEmpty,
          row(
            [h('span', { text: '只列出应用数据目录里的（最多 20 条）；不含升级前 / 恢复前 / 定期的自动备份' })],
            cleanButton
          )
        ]),
        h('div', { class: 'settings-panel is-danger' }, [
          h('p', { class: 'settings-panel-title', text: '危险区' }),
          h('div', { class: 'set-row is-first' }, [
            h('span', { class: 'set-row-main' }, [
              h('b', { text: '一键清除本库数据' }),
              h('span', { text: '删除会话、消息、摘要与当前存储的附件文件；账号保留，不可恢复' })
            ]),
            purgeButton
          ])
        ])
      );

      function formatTime(ms) {
        const date = new Date(ms || Date.now());
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
          date.getMinutes()
        )}`;
      }

      function formatSize(bytes) {
        const size = Number(bytes) || 0;
        if (size < 1024) {
          return `${size} B`;
        }
        if (size < 1024 * 1024) {
          return `${(size / 1024).toFixed(1)} KB`;
        }
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
      }

      async function refreshStorage() {
        let status = {};
        try {
          status = (await bridge.backendStatus()) || {};
        } catch (error) {
          status = {};
        }
        state.storageBackend = status.backend || '';
        state.connection = status.connection || null;
        const remote = Boolean(state.connection && state.connection.remote);
        const label =
          state.storageBackend === 'sqlite'
            ? '本机 SQLite'
            : state.storageBackend === 'mysql'
              ? remote
                ? '远程 MySQL'
                : '本机 MySQL'
              : '未知';
        storageCurrent.textContent = label;
        const where = status.location ? status.location : '';
        const tls = remote && state.connection && state.connection.ssl ? ' · TLS' : '';
        storageDetail.textContent = `${where}${tls}${status.ok ? '' : '（后端未就绪）'}`.trim() || '—';
        const pillRemote = state.storageBackend === 'mysql' && remote;
        storagePill.textContent = pillRemote ? '远程数据库' : state.storageBackend === 'mysql' ? '本机 MySQL' : '本机数据';
        storagePill.classList.toggle('is-warn', pillRemote);
        footHint.textContent = `当前存储：${label} · 版本 ${VERSION}`;
        // 后端没就绪时也必须能点：切库正是「后端起不来」时唯一的自救入口，
        // 禁用等于把用户锁死在坏配置里（风险提示放在窗口内，见 storage.js）
        switchStorage.disabled = false;
      }

      async function refreshArtifacts() {
        let listed = {};
        try {
          listed = (await bridge.listArtifacts()) || {};
        } catch (error) {
          listed = {};
        }
        const items = Array.isArray(listed.items) ? listed.items : [];
        state.artifacts = items;
        artifactList.textContent = '';
        artifactList.hidden = items.length === 0;
        artifactEmpty.hidden = items.length > 0;
        items.forEach((item) => {
          const node = h('li', { class: item.missing ? 'artifact-item is-missing' : 'artifact-item' });
          node.dataset.id = item.id;
          node.append(
            h('span', { class: 'artifact-name', text: `${item.label} · ${item.name}`, title: item.path || item.name }),
            h('span', {
              class: 'artifact-meta',
              text: item.missing ? '文件已移动或删除' : `${formatTime(item.createdAt)} · ${formatSize(item.size)}`
            })
          );
          const actions = h('span', { class: 'artifact-actions' });
          const make = (action, text, danger) => {
            const button = h('button', { class: `btn-text${danger ? ' is-danger' : ''}`, type: 'button', text });
            button.dataset.action = action;
            actions.appendChild(button);
            return button;
          };
          if (item.missing) {
            make('relocate', '重新定位', false);
            make('forget', '移除记录', false);
          } else {
            make('restore', '用它恢复', false);
            make('reveal', item.isDir ? '打开文件夹' : '打开所在文件夹', false);
            make('delete', '删除', true);
          }
          node.appendChild(actions);
          artifactList.appendChild(node);
        });
      }

      artifactList.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) {
          return;
        }
        const node = button.closest('.artifact-item');
        const id = node && node.dataset.id;
        if (!id) {
          return;
        }
        const action = button.dataset.action;
        if (action === 'reveal') {
          bridge.revealArtifact(id);
          return;
        }
        if (action === 'restore') {
          const item = state.artifacts.find((entry) => entry.id === id);
          ctx.openWindow('restore', item ? { from: item.path } : {});
          return;
        }
        if (action === 'relocate') {
          bridge.relocateArtifact(id).then((result) => {
            if (result && result.ok) {
              refreshArtifacts();
            } else if (result && !result.canceled) {
              ctx.toast((result && result.error) || '重新定位失败', 'error');
            }
          });
          return;
        }
        if (action === 'forget') {
          askConfirm(
            '移除这条记录？',
            '只从列表里移除，不会删除任何文件。',
            '移除',
            async () => {
              const result = await bridge.forgetArtifact(id);
              if (result && result.ok) {
                refreshArtifacts();
              } else {
                ctx.toast((result && result.error) || '移除失败', 'error');
              }
            }
          );
          return;
        }
        askConfirm('删除这个文件？', '删除后无法恢复。只删这份备份 / 导出，数据库本身不受影响。', '删除', async () => {
          const result = await bridge.deleteArtifact(id);
          if (result && result.ok) {
            refreshArtifacts();
          } else {
            ctx.toast((result && result.error) || '删除失败', 'error');
          }
        });
      });

      /**
       * 确认框是独立窗口：结果经 opener 路由回到本窗口（见下方 onReply）。
       * 按窗口 id 存回调——确认框允许同时开多扇（删产物 + 清理旧产物），
       * 只留一个槽位会让后开的顶掉先开的，点了「确认」执行到别人的动作上。
       */
      const pendingConfirms = new Map();
      function askConfirm(title, text, okText, onConfirm) {
        Promise.resolve(ctx.openWindow('confirm', { title, text, okText })).then((opened) => {
          if (opened && opened.ok) {
            pendingConfirms.set(opened.id, onConfirm);
          }
        });
      }

      switchStorage.addEventListener('click', () => {
        ctx.openWindow('storage', { backend: state.storageBackend, connection: state.connection });
      });
      backupButton.addEventListener('click', () => ctx.openWindow('save', { mode: 'backup' }));
      exportButton.addEventListener('click', () => ctx.openWindow('save', { mode: 'export' }));
      restoreButton.addEventListener('click', () => ctx.openWindow('restore', {}));

      cleanButton.addEventListener('click', async () => {
        const preview = await bridge.cleanOldArtifacts({ days: CLEAN_OLD_DAYS });
        if (!preview || !preview.ok) {
          ctx.toast((preview && preview.error) || '读取待清理的产物失败', 'error');
          return;
        }
        if (!preview.count) {
          ctx.toast(`没有超过 ${CLEAN_OLD_DAYS} 天的备份或导出`);
          return;
        }
        const names = preview.items.slice(0, 5).map((item) => item.name).join('、');
        const more = preview.count > 5 ? ` 等 ${preview.count} 项` : '';
        askConfirm(
          `清理 ${preview.count} 项旧产物？`,
          `只清理本应用生成的备份与导出（不含升级前 / 恢复前 / 定期的自动备份）：${names}${more}，共 ${formatSize(
            preview.bytes
          )}。删除后无法恢复。`,
          '确认清理',
          async () => {
            const result = await bridge.cleanOldArtifacts({ days: CLEAN_OLD_DAYS, confirm: true });
            if (!result || !result.ok) {
              ctx.toast((result && result.error) || '清理失败', 'error');
              return;
            }
            refreshArtifacts();
            const mb = ((Number(result.freed) || 0) / (1024 * 1024)).toFixed(1);
            const failed = Array.isArray(result.failed) && result.failed.length ? `；${result.failed.length} 项删不掉` : '';
            ctx.toast(`已清理 ${result.removed || 0} 项，释放 ${mb} MB${failed}`);
          }
        );
      });

      purgeButton.addEventListener('click', () => {
        const label =
          state.storageBackend === 'sqlite' ? 'SQLite' : state.storageBackend === 'mysql' ? 'MySQL' : '当前';
        askConfirm(
          '清除本库全部数据？',
          `将删除${label}存储里的全部会话、消息、摘要与附件文件，账号保留。删除后无法恢复，建议先备份。`,
          '确认清除',
          async () => {
            const result = await bridge.purgeStorage();
            if (!result || !result.ok) {
              ctx.toast((result && result.error) || '清除失败', 'error');
              return;
            }
            refreshStorage();
            refreshArtifacts();
            ctx.toast('已清除本库数据');
          }
        );
      });

      autoEnabled.addEventListener('change', saveAutoBackup);
      autoDays.addEventListener('change', saveAutoBackup);

      async function saveAutoBackup() {
        const raw = Number(autoDays.value);
        const saved = await bridge.writeConfig({
          autoBackupEnabled: autoEnabled.checked,
          autoBackupDays: Number.isFinite(raw) ? raw : 7
        });
        state.config.autoBackupEnabled = saved.autoBackupEnabled !== false;
        state.config.autoBackupDays = Number(saved.autoBackupDays) || 7;
        autoEnabled.checked = state.config.autoBackupEnabled;
        autoDays.value = String(state.config.autoBackupDays);
        autoTip.textContent = state.config.autoBackupEnabled
          ? `已保存：每隔 ${state.config.autoBackupDays} 天自动备份一次（下次启动时检查）`
          : '已保存：定期自动备份已关闭';
        autoTip.hidden = false;
      }

      function syncAutoBackup() {
        autoEnabled.checked = state.config.autoBackupEnabled !== false;
        autoDays.value = String(state.config.autoBackupDays || 7);
        autoTip.hidden = true;
      }

      // ---------- 模型 ----------
      const modelList = h('ul', { class: 'artifact-list', hidden: true });
      const modelEmpty = h('p', { class: 'settings-hint', text: '还没有模型，点下面「添加模型」开始。' });
      const addModel = h('button', { class: 'btn-ghost', type: 'button', text: '添加模型' });
      const modelTip = h('p', { class: 'auth-tip', hidden: true });

      paneSections.get('models').append(
        h('p', {
          class: 'settings-hint',
          text: '模型由你自己添加：填 Base URL、API Key 与模型 ID（兼容 OpenAI 协议的接口都行）。选哪个模型就用哪个模型自己的 Key；Key 加密保存在本机，界面不回显。'
        }),
        modelList,
        modelEmpty,
        h('div', { class: 'storage-actions' }, [addModel]),
        modelTip
      );

      function setModelTip(text, isError) {
        modelTip.textContent = text || '';
        modelTip.hidden = !text;
        modelTip.classList.toggle('is-error', Boolean(text) && Boolean(isError));
      }

      function modelStatusOf(item) {
        if (!item.hasKey) {
          return { text: '未配置 Key', cls: 'is-missing' };
        }
        const check = state.checks[item.id];
        if (check && check.ok === false) {
          return { text: `验证失败：${check.error || '未知原因'}`, cls: 'is-error' };
        }
        if (check && check.ok) {
          return { text: '可用', cls: '' };
        }
        return { text: '已配置', cls: '' };
      }

      function renderModels() {
        const config = state.models || { models: [], default: '' };
        const items = Array.isArray(config.models) ? config.models : [];
        modelList.textContent = '';
        modelList.hidden = items.length === 0;
        modelEmpty.hidden = items.length > 0;
        items.forEach((item) => {
          const node = h('li', { class: 'artifact-item model-item' });
          node.dataset.id = item.id;
          const info = modelStatusOf(item);
          node.append(
            h('span', {
              class: 'artifact-name',
              text: `${item.name} · ${item.model}`,
              title: `${item.baseUrl}\n模型 ID：${item.model}`
            }),
            h('span', { class: `artifact-meta ${info.cls}`, text: info.text })
          );
          const actions = h('span', { class: 'artifact-actions' });
          const make = (action, text, danger) => {
            const button = h('button', { class: `btn-text${danger ? ' is-danger' : ''}`, type: 'button', text });
            button.dataset.action = action;
            actions.appendChild(button);
          };
          if (config.default !== item.id) {
            make('default', '设为默认', false);
          } else {
            actions.appendChild(h('span', { class: 'model-default-badge', text: '默认' }));
          }
          make('verify', '验证', false);
          make('edit', '编辑', false);
          make('delete', '删除', true);
          node.appendChild(actions);
          modelList.appendChild(node);
        });
      }

      async function refreshModels() {
        // 配置（Key / Base URL / 模型名）变了，上一次「验证失败：…」就不再成立；
        // 不清的话用户改完 Key 仍看到旧的红色结论，会以为改动没生效
        state.checks = {};
        try {
          const listed = (await bridge.listModels()) || {};
          state.models = {
            models: Array.isArray(listed.models) ? listed.models : [],
            default: String(listed.default || '')
          };
          state.presets = Array.isArray(listed.presets) ? listed.presets : [];
        } catch (error) {
          setModelTip('读取模型配置失败', true);
        }
        renderModels();
      }

      modelList.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) {
          return;
        }
        const node = button.closest('.model-item');
        const id = node && node.dataset.id;
        if (!id) {
          return;
        }
        const action = button.dataset.action;
        if (action === 'edit') {
          ctx.openWindow('model', { id });
          return;
        }
        if (action === 'verify') {
          verifyModel(id);
          return;
        }
        if (action === 'default') {
          bridge.setDefaultModel(id).then((result) => {
            if (!result || !result.ok) {
              setModelTip((result && result.error) || '设置默认模型失败', true);
              return;
            }
            refreshModels();
            ctx.toast('已设为默认模型');
          });
          return;
        }
        const item = (state.models.models || []).find((entry) => entry.id === id);
        askConfirm(
          `删除模型「${item ? item.name : ''}」？`,
          '只会从本机配置里移除这个模型，不会影响上游账号。删除后会自动重启本地服务。',
          '删除',
          async () => {
            const result = await bridge.deleteModel(id);
            if (!result || !result.ok) {
              setModelTip((result && result.error) || '删除失败', true);
              return;
            }
            refreshModels();
            ctx.toast('模型已删除');
          }
        );
      });

      async function verifyModel(id) {
        try {
          const body = await ctx.kit.requestJson('/models/verify', {
            method: 'POST',
            json: { id },
            timeout: 20000
          });
          const payload = body && typeof body === 'object' ? body : {};
          if (payload.ok === undefined) {
            return; // 后端版本较旧时不显示验证结果，不影响主流程
          }
          state.checks[id] = payload;
        } catch (error) {
          state.checks[id] = { ok: false, error: (error && error.message) || '验证请求失败' };
        }
        renderModels();
      }

      addModel.addEventListener('click', () => ctx.openWindow('model', {}));

      // ---------- 关于 ----------
      paneSections.get('about').append(
        h('p', {
          class: 'settings-hint',
          text: '随心问答 · 本机运行的桌面 AI 客户端：流式对话、跨轮记忆、历史会话、文件提问。'
        }),
        h('dl', { class: 'about-list' }, [
          h('div', {}, [h('dt', { text: '版本' }), h('dd', { text: VERSION })]),
          h('div', {}, [h('dt', { text: '运行方式' }), h('dd', { text: 'Electron 窗口 + 本机 FastAPI 后端' })]),
          h('div', {}, [
            h('dt', { text: '数据位置' }),
            h('dd', { text: '默认本机 SQLite；切到 MySQL 后存于你配置的数据库（可以是远程）' })
          ]),
          h('div', {}, [h('dt', { text: '密钥' }), h('dd', { text: '模型 API Key 加密保存在本机（Windows 走 DPAPI），界面不回显' })]),
          h('div', {}, [h('dt', { text: '许可' }), h('dd', { text: 'MIT（logo 与品牌标识保留所有权利）' })])
        ])
      );

      // ---------- 子窗口结果 / 广播 ----------
      // 设置窗是单例，再次打开时外壳可能整块重挂：旧实例必须能彻底退订，
      // 否则每重开一次就多一套监听（旧闭包还会执行删除确认、刷新已脱离文档的节点）
      const unsubscribes = [];
      function track(unsubscribe) {
        if (typeof unsubscribe === 'function') {
          unsubscribes.push(unsubscribe);
        }
      }
      track(
        bridge.onReply((packet) => {
        if (!packet) {
          return;
        }
        // 模型窗口保存成功：这里给提示并重拉列表（重启后端的副作用由主进程广播兜住）
        if (packet.from === 'model') {
          if (packet.data && packet.data.action === 'saved') {
            ctx.toast(packet.data.message || '模型已保存');
            refreshModels();
          }
          return;
        }
        if (packet.from !== 'confirm') {
          return;
        }
        const handler = pendingConfirms.get(packet.windowId);
        pendingConfirms.delete(packet.windowId);
        if (handler && packet.data && packet.data.action === 'confirm') {
          handler();
        }
        })
      );
      // 确认框被直接关掉（点 × / Esc）时不会有 reply：不清理就会在设置窗口生命周期内
      // 一直留着那条闭包（以及它捕获的 DOM），连续弹几次确认框就攒几次
      if (typeof bridge.onWindowClosed === 'function') {
        track(
          bridge.onWindowClosed((packet) => {
            const windowId = packet && packet.windowId;
            if (windowId) {
              pendingConfirms.delete(windowId);
            }
          })
        );
      }
      track(
        bridge.onArtifactsChanged(() => {
          if (!paneSections.get('storage').hidden) {
            refreshArtifacts();
          }
        })
      );
      track(
        bridge.onModelsChanged(() => {
          refreshModels();
          // 模型改动会重启后端：连接状态与存储信息也可能变了
          refreshStorage();
        })
      );
      track(
        bridge.onBackendRestarted(() => {
          refreshStorage();
          refreshArtifacts();
        })
      );
      track(
        bridge.onConfigChanged((conf) => {
          state.config = Object.assign({}, state.config, conf || {});
          syncAppearance();
          syncAutoBackup();
          if (!paneSections.get('connection').hidden) {
            apiInput.value = state.config.apiBase || '';
          }
        })
      );

      // ---------- 启动 ----------
      async function init() {
        state.config = (await bridge.readConfig()) || {};
        apiInput.value = state.config.apiBase || '';
        syncAppearance();
        syncAutoBackup();
        activate('appearance');
        refreshStorage();
        // 产物与模型在后台预读：切到对应分区时不用再等
        refreshArtifacts();
        refreshModels();
      }
      init();

      return {
        onEscape() {
          ctx.close();
          return true;
        },
        // 外壳整块重挂前会调用：退订所有广播 + 清掉挂起的确认闭包
        destroy() {
          unsubscribes.forEach((unsubscribe) => {
            try {
              unsubscribe();
            } catch (error) {
              console.error('[设置] 取消订阅失败', error);
            }
          });
          unsubscribes.length = 0;
          pendingConfirms.clear();
        }
      };
    }
  };
})();
