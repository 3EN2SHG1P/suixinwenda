/**
 * 文件：desktop/src/renderer/views/save.js
 * 职责：保存备份 / 导出数据窗口——三态（表单 → 进行中 → 结果）；位置与名称都由用户在这里确认。
 * 载荷：{ mode: 'backup' | 'export' }
 * 口径：与 storage.js 的 SAVE_MODES 完全一致（默认名、按钮文案、失败提示）。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const MODES = {
    backup: {
      title: '保存备份',
      hint: '备份包含数据库快照与全部附件。先确认存到哪，再决定叫什么。',
      nameLabel: '文件名',
      okText: '开始备份',
      progress: '正在备份，请稍候…',
      defaultName: (stamp) => `suixinwenda-${stamp}.zip`,
      dirKey: 'backupDir'
    },
    export: {
      title: '导出数据',
      hint: '导出的是各表的结构化数据（JSONL + manifest）。先确认存到哪，再决定叫什么。',
      nameLabel: '目录名称',
      okText: '开始导出',
      progress: '正在导出，请稍候…',
      defaultName: (stamp) => `suixinwenda-${stamp}`,
      dirKey: 'exportDir'
    }
  };

  function saveStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${date}-${time}`;
  }

  function joinPathText(dir, name) {
    if (!dir) {
      return name;
    }
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
  }

  window.SXW_VIEWS.save = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const mode = (ctx.payload && ctx.payload.mode) === 'export' ? 'export' : 'backup';
      const config = MODES[mode];
      const pending = { dir: '', name: '' };
      let resultPath = '';

      // 窗口名跟模式走（保存备份 / 导出数据），卡片里不再重复一遍
      ctx.setTitle(config.title);
      const hint = h('p', { class: 'modal-text', text: config.hint });
      const dirInput = h('input', { class: 'auth-input', type: 'text', readonly: true, placeholder: '还没有选择' });
      const pickButton = h('button', { class: 'btn-ghost', type: 'button', text: '选择…' });
      const nameLabel = h('span', { class: 'auth-label', text: config.nameLabel });
      const nameInput = h('input', { class: 'auth-input', type: 'text', maxlength: 80 });
      const preview = h('p', { class: 'save-preview' });
      const tip = h('p', { class: 'auth-tip', hidden: true });
      const cancelButton = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const okButton = h('button', { class: 'btn-primary', type: 'button', text: config.okText });

      const form = h('div', {}, [
        hint,
        h('label', { class: 'auth-field' }, [
          h('span', { class: 'auth-label', text: '保存位置' }),
          h('span', { class: 'path-row' }, [dirInput, pickButton])
        ]),
        h('label', { class: 'auth-field' }, [nameLabel, nameInput]),
        preview,
        tip,
        h('div', { class: 'modal-actions' }, [cancelButton, okButton])
      ]);

      const progressText = h('p', { class: 'modal-text', text: config.progress });
      const progress = h('div', { hidden: true }, [progressText, h('div', { class: 'progress-track' }, [h('span', { class: 'progress-bar' })])]);

      const resultIcon = h('p', { class: 'save-result-icon' });
      const resultTitle = h('p', { class: 'save-result-title' });
      const resultPathEl = h('p', { class: 'save-result-path' });
      const resultExtra = h('p', { class: 'save-result-extra' });
      const revealButton = h('button', { class: 'btn-ghost', type: 'button', text: '打开所在文件夹', hidden: true });
      const retryButton = h('button', { class: 'btn-ghost', type: 'button', text: '返回修改', hidden: true });
      const doneButton = h('button', { class: 'btn-primary', type: 'button', text: '完成' });
      const result = h('div', { hidden: true }, [
        resultIcon,
        resultTitle,
        resultPathEl,
        resultExtra,
        h('div', { class: 'modal-actions' }, [revealButton, retryButton, doneButton])
      ]);

      root.appendChild(h('div', { class: 'modal-card aw-card', role: 'dialog', 'aria-modal': 'true' }, [form, progress, result]));

      function view(name) {
        form.hidden = name !== 'form';
        progress.hidden = name !== 'progress';
        result.hidden = name !== 'result';
        // 执行中禁止关窗：备份子进程正在写盘，窗口先没了会让人以为失败了
        ctx.setClosable(name !== 'progress');
        if (name === 'form') {
          syncForm();
        }
      }

      function setTip(text) {
        tip.textContent = text || '';
        tip.hidden = !text;
        tip.classList.toggle('is-error', Boolean(text));
      }

      function syncForm() {
        dirInput.value = pending.dir || '';
        nameInput.value = pending.name || '';
        preview.textContent =
          pending.dir && pending.name ? `将保存到：${joinPathText(pending.dir, pending.name)}` : '（位置或名称还没填）';
      }

      async function init() {
        const defaults = (await ctx.bridge.saveDefaults()) || {};
        pending.dir = defaults[config.dirKey] || '';
        pending.name = config.defaultName(saveStamp());
        view('form');
        nameInput.focus();
        nameInput.select();
      }

      pickButton.addEventListener('click', async () => {
        const picked = await ctx.bridge.pickDirectory('选择保存位置');
        if (picked && picked.ok && picked.dir) {
          pending.dir = picked.dir;
          syncForm();
        }
      });
      nameInput.addEventListener('input', () => {
        pending.name = nameInput.value;
        syncForm();
      });

      function showResult(payload) {
        resultIcon.textContent = payload.ok ? '✓' : '✕';
        resultIcon.classList.toggle('is-error', !payload.ok);
        resultTitle.textContent = payload.title;
        resultPathEl.textContent = payload.path || '';
        resultExtra.textContent = payload.extra || '';
        resultExtra.classList.toggle('is-error', !payload.ok);
        revealButton.textContent = mode === 'export' ? '打开导出文件夹' : '打开所在文件夹';
        revealButton.hidden = !payload.ok;
        retryButton.hidden = Boolean(payload.ok);
        resultPath = payload.path || '';
        view('result');
      }

      async function execute(dir, name) {
        progressText.textContent = config.progress;
        view('progress');
        let output = null;
        try {
          output =
            mode === 'backup' ? await ctx.bridge.createBackup(dir, name) : await ctx.bridge.exportData(dir, name);
        } catch (error) {
          output = { ok: false, error: (error && error.message) || '操作失败' };
        }
        const fallbackPath = joinPathText(dir, name);
        if (output && output.ok) {
          resultPath = output.path || fallbackPath;
          const extra =
            mode === 'backup'
              ? `附件 ${output.files || 0} 个${
                  output.dump_method === 'builtin' ? '；数据库用内置导出（无需 mysqldump）' : ''
                }`
              : Object.entries(output.tables || {})
                  .map(([key, rows]) => `${key} ${rows} 行`)
                  .join('、');
          showResult({
            ok: true,
            title: mode === 'backup' ? '备份完成' : '导出完成',
            path: resultPath,
            extra
          });
          return;
        }
        showResult({
          ok: false,
          title: mode === 'backup' ? '备份失败' : '导出失败',
          path: fallbackPath,
          extra: (output && output.error) || '未知错误'
        });
      }

      okButton.addEventListener('click', () => {
        const name = String(pending.name || '').trim();
        if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
          setTip('名称不能为空，也不能包含 \\ / : * ? " < > |');
          return;
        }
        if (!pending.dir) {
          setTip('请先选择保存位置');
          return;
        }
        // 备份必须带 .zip：主进程会拒绝，但那时进度视图已经跑完了，用户只看到一句失败
        if (mode === 'backup' && !/\.zip$/i.test(name)) {
          setTip('备份文件名需要以 .zip 结尾');
          return;
        }
        setTip('');
        execute(pending.dir, name);
      });
      cancelButton.addEventListener('click', () => ctx.close());
      doneButton.addEventListener('click', () => ctx.close());
      retryButton.addEventListener('click', () => view('form'));
      revealButton.addEventListener('click', () => {
        if (resultPath) {
          ctx.bridge.revealPath(resultPath);
        }
      });

      init();

      return {
        // 执行中不接受新载荷（重挂会把进度视图丢掉）；空闲时返回 false 让外壳整块重挂
        onPayload() {
          return !progress.hidden;
        },
        onEscape() {
          // 执行中不许用 Esc 绕过：与标题栏 × 一样被挡住
          if (!progress.hidden) {
            ctx.toast('正在执行，完成前不能关闭这个窗口', 'error');
            return true;
          }
          ctx.close();
          return true;
        }
      };
    }
  };
})();
