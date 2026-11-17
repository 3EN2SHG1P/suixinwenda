/**
 * 文件：desktop/src/renderer/views/restore.js
 * 职责：从备份恢复窗口——三态（表单 → 进行中 → 结果）；来源可以选文件、选目录或从历史产物里挑。
 * 载荷：{ from?, uploadsFrom? }
 * 口径：与 storage.js 的恢复流程一致（force 勾选语义、结果里的恢复前备份路径、失败也能回滚）。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const PICK_LIMIT = 6;

  window.SXW_VIEWS.restore = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const state = {
        from: (ctx.payload && ctx.payload.from) || '',
        uploads: (ctx.payload && ctx.payload.uploadsFrom) || '',
        picks: [],
        preBackup: ''
      };

      const tip = h('p', { class: 'auth-tip', hidden: true });
      const fromInput = h('input', { class: 'auth-input', type: 'text', readonly: true, placeholder: '还没有选择' });
      const pickZip = h('button', { class: 'btn-ghost', type: 'button', text: '选备份…' });
      const pickDir = h('button', { class: 'btn-ghost', type: 'button', text: '选目录…' });
      const uploadsInput = h('input', {
        class: 'auth-input',
        type: 'text',
        readonly: true,
        placeholder: '仅用于给导出目录补充附件'
      });
      const pickUploads = h('button', { class: 'btn-ghost', type: 'button', text: '选备份…' });
      const picksList = h('div', { class: 'restore-picks', hidden: true });
      const picksEmpty = h('p', { class: 'settings-hint', hidden: true, text: '还没有备份或导出记录。' });
      const force = h('input', { type: 'checkbox' });
      const cancelButton = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const okButton = h('button', { class: 'btn-primary', type: 'button', text: '开始恢复', disabled: true });

      const form = h('div', {}, [
        h('p', {
          class: 'modal-text',
          text: '选一个备份包（.zip），或一次「导出数据」生成的目录。恢复会写进当前库：不勾下面那项时，库里已有会话数据会被直接拒绝。'
        }),
        h('label', { class: 'auth-field' }, [
          h('span', { class: 'auth-label', text: '恢复来源' }),
          h('span', { class: 'path-row' }, [fromInput, pickZip, pickDir])
        ]),
        h('div', { class: 'restore-picks-block' }, [
          h('p', { class: 'settings-hint', text: '或直接从最近的备份 / 导出里选：' }),
          picksList,
          picksEmpty
        ]),
        h('label', { class: 'auth-field' }, [
          h('span', { class: 'auth-label', text: '附件来源（可选）' }),
          h('span', { class: 'path-row' }, [uploadsInput, pickUploads])
        ]),
        h('p', {
          class: 'settings-hint',
          text: '「导出数据」只有各表的结构化数据，不含附件；附件只在备份包（.zip）里。要连附件一起恢复，就在附件来源里选同一个备份包。'
        }),
        h('label', { class: 'restore-check' }, [
          force,
          h('span', { text: '将先备份当前库，再清空当前库（现有会话与附件文件会被删除）' })
        ]),
        tip,
        h('div', { class: 'modal-actions' }, [cancelButton, okButton])
      ]);

      const progressText = h('p', { class: 'modal-text' });
      const progress = h('div', { hidden: true }, [
        progressText,
        h('div', { class: 'progress-track' }, [h('span', { class: 'progress-bar' })])
      ]);

      const resultIcon = h('p', { class: 'save-result-icon' });
      const resultTitle = h('p', { class: 'save-result-title' });
      const resultDetail = h('p', { class: 'save-result-extra' });
      const resultBackup = h('p', { class: 'save-result-path', hidden: true });
      const revealButton = h('button', { class: 'btn-ghost', type: 'button', text: '打开所在文件夹', hidden: true });
      const retryButton = h('button', { class: 'btn-ghost', type: 'button', text: '返回修改', hidden: true });
      const doneButton = h('button', { class: 'btn-primary', type: 'button', text: '完成' });
      const result = h('div', { hidden: true }, [
        resultIcon,
        resultTitle,
        resultDetail,
        resultBackup,
        h('div', { class: 'modal-actions' }, [revealButton, retryButton, doneButton])
      ]);

      root.appendChild(
        h('div', { class: 'modal-card aw-card', role: 'dialog', 'aria-modal': 'true' }, [
          // 窗口名已在标题栏，卡片里直接进表单
          form,
          progress,
          result
        ])
      );

      function setTip(text) {
        tip.textContent = text || '';
        tip.hidden = !text;
        tip.classList.toggle('is-error', Boolean(text));
      }

      function sync() {
        fromInput.value = state.from || '';
        uploadsInput.value = state.uploads || '';
        okButton.disabled = !state.from;
        picksList.querySelectorAll('.restore-pick').forEach((row) => {
          const item = state.picks.find((entry) => entry.id === row.dataset.id);
          const chosen = Boolean(item && item.path && (item.path === state.from || item.path === state.uploads));
          row.classList.toggle('is-selected', chosen);
        });
      }

      function view(name) {
        form.hidden = name !== 'form';
        progress.hidden = name !== 'progress';
        result.hidden = name !== 'result';
        ctx.setClosable(name !== 'progress');
        if (name === 'form') {
          sync();
        }
      }

      function formatTime(ms) {
        const date = new Date(ms || Date.now());
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
          date.getMinutes()
        )}`;
      }

      async function refreshPicks() {
        const listed = (await ctx.bridge.listArtifacts()) || {};
        const items = (Array.isArray(listed.items) ? listed.items : [])
          .filter((item) => !item.missing && (item.kind === 'backup' || item.kind === 'export'))
          .slice(0, PICK_LIMIT);
        state.picks = items;
        picksList.textContent = '';
        picksList.hidden = items.length === 0;
        picksEmpty.hidden = items.length > 0;
        items.forEach((item) => {
          const row = h('div', { class: 'restore-pick', role: 'button', tabindex: 0, title: item.path || item.name });
          row.dataset.id = item.id;
          row.append(
            h('span', { class: 'restore-pick-name', text: `${item.label} · ${item.name}` }),
            h('span', {
              class: 'restore-pick-meta',
              text: `${formatTime(item.createdAt)} · ${item.isDir ? '目录' : ctx.kit.formatFileSize(item.size)}`
            })
          );
          // 导出目录里没有附件，只有备份包才有「设为附件」的意义
          if (item.kind === 'backup') {
            row.append(h('button', { class: 'btn-text', type: 'button', text: '设为附件', dataset: { pick: 'uploads' } }));
          }
          row.addEventListener('click', (event) => {
            const asUploads = event.target.closest('button[data-pick="uploads"]');
            if (asUploads) {
              state.uploads = item.path || '';
            } else {
              state.from = item.path || '';
              // 换了主来源，之前挑的附件来源多半对不上：清掉更安全
              state.uploads = '';
            }
            sync();
          });
          picksList.appendChild(row);
        });
        sync();
      }

      async function choose(kind) {
        const isDir = kind === 'dir';
        const picked = isDir ? await ctx.bridge.pickDirectory('选择导出目录') : await ctx.bridge.pickRestoreFile();
        if (!picked || picked.canceled) {
          return;
        }
        if (!picked.ok) {
          ctx.toast(picked.error || '这个路径不可用', 'error');
          return;
        }
        const target = isDir ? picked.dir : picked.path;
        if (kind === 'uploads') {
          state.uploads = target;
        } else {
          state.from = target;
          state.uploads = '';
        }
        sync();
      }

      pickZip.addEventListener('click', () => choose('zip'));
      pickDir.addEventListener('click', () => choose('dir'));
      pickUploads.addEventListener('click', () => choose('uploads'));

      function showResult(payload) {
        const ok = Boolean(payload.ok);
        resultIcon.textContent = ok ? '✓' : '✕';
        resultIcon.classList.toggle('is-error', !ok);
        resultTitle.textContent = ok ? '恢复完成' : '恢复失败';
        resultDetail.textContent = (ok ? payload.detail : payload.error) || '';
        resultDetail.classList.toggle('is-error', !ok);
        resultBackup.textContent = payload.preBackup
          ? `${ok ? '恢复前的备份' : '失败前的备份（可用来回滚）'}：${payload.preBackup}`
          : '';
        resultBackup.hidden = !payload.preBackup;
        revealButton.hidden = !payload.preBackup;
        retryButton.hidden = ok;
        state.preBackup = payload.preBackup || '';
        view('result');
      }

      async function execute() {
        if (!state.from) {
          setTip('请先选择要恢复的备份包或导出目录');
          return;
        }
        const useForce = Boolean(force.checked);
        progressText.textContent = useForce
          ? '正在恢复：校验备份 → 备份当前库 → 清空当前库 → 恢复附件 → 写入数据库，请稍候…'
          : '正在恢复：校验备份 → 备份当前库 → 恢复附件 → 写入数据库，请稍候…';
        view('progress');
        let output = null;
        try {
          output = await ctx.bridge.restoreStorage({
            from: state.from,
            uploadsFrom: state.uploads,
            force: useForce
          });
        } catch (error) {
          output = { ok: false, error: (error && error.message) || '恢复失败' };
        }
        if (!output || !output.ok) {
          showResult({
            ok: false,
            error: (output && output.error) || '恢复失败',
            preBackup: (output && output.pre_backup) || ''
          });
          return;
        }
        const tableText = Object.entries(output.tables || {})
          .map(([name, rows]) => `${name} ${rows} 行`)
          .join('、');
        let detail = `${tableText || '没有写入任何表'}；附件 ${output.files || 0} 个`;
        if (output.users_merged) {
          detail += `；合并已有账号 ${output.users_merged} 个（密码以当前库为准）`;
        }
        if (Array.isArray(output.legacy_tables) && output.legacy_tables.length) {
          detail += `；同时恢复了停止使用的历史表：${output.legacy_tables.join('、')}`;
        }
        if (output.warning) {
          detail += `。${output.warning}`;
        }
        showResult({ ok: true, detail, preBackup: output.pre_backup || '' });
      }

      okButton.addEventListener('click', execute);
      cancelButton.addEventListener('click', () => ctx.close());
      doneButton.addEventListener('click', () => ctx.close());
      retryButton.addEventListener('click', () => view('form'));
      revealButton.addEventListener('click', () => {
        if (state.preBackup) {
          ctx.bridge.revealPath(state.preBackup);
        }
      });

      view('form');
      refreshPicks().catch((error) => console.warn('[恢复] 读取历史产物失败', error));

      return {
        // 执行中不接受新载荷；空闲时交给外壳整块重挂（带新的恢复来源）
        onPayload() {
          return !progress.hidden;
        },
        onEscape() {
          if (!progress.hidden) {
            ctx.toast('正在恢复，完成前不能关闭这个窗口', 'error');
            return true;
          }
          ctx.close();
          return true;
        }
      };
    }
  };
})();
