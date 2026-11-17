/**
 * 文件：desktop/src/renderer/views/preview.js
 * 职责：文档预览窗口——正文取后端抽取结果（带鉴权），「用系统程序打开 / 另存为」走主进程临时文件。
 * 载荷：{ attachment: { id, localKey, name, mime, size, kind, base64 } }
 *      localKey 且带 base64 的是「刚选还没发送」的本地文件；有过 id 的历史附件自己按 id 取原文件。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const DOC_PREVIEW_CHARS = 5000; // 与后端 core.files.MAX_DOC_CHARS 同源，仅用于文案
  const PREVIEW_TIMEOUT = 30000;

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      };
      reader.onerror = () => reject(new Error('文件读取失败，请重试'));
      reader.readAsDataURL(blob);
    });
  }

  window.SXW_VIEWS.preview = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const attachment = (ctx.payload && ctx.payload.attachment) || {};
      const label = ctx.kit.attachLabel(attachment.mime, attachment.name);

      const meta = h('p', { class: 'preview-meta', text: `${label} · ${ctx.kit.formatFileSize(attachment.size)}` });
      const body = h('div', { class: 'preview-body' });
      const openButton = h('button', { class: 'btn-ghost', type: 'button', text: '用系统程序打开' });
      const saveButton = h('button', { class: 'btn-ghost', type: 'button', text: '另存为' });
      const doneButton = h('button', { class: 'btn-primary', type: 'button', text: '关闭' });

      root.appendChild(
        h('div', { class: 'modal-card modal-card-preview', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { class: 'settings-head' }, [
            h('h3', { class: 'modal-title', text: attachment.name || '文件预览', title: attachment.name || '文件预览' })
          ]),
          meta,
          body,
          h('div', { class: 'modal-actions' }, [openButton, saveButton, doneButton])
        ])
      );
      // 关窗只留标题栏的 × 与这里一个主按钮：窗口里不再出现第二个「关闭」
      doneButton.addEventListener('click', () => ctx.close());

      function placeEmpty(text) {
        body.textContent = '';
        body.appendChild(h('p', { class: 'preview-empty', text }));
      }

      async function loadText() {
        // 1. 本地刚选的文件：正文由后端解析，这时还没有，只说明清楚
        if (attachment.localKey) {
          placeEmpty('文档正文由后端解析，发送之后就能在这里查看完整内容；图片可以直接放大查看。');
          return;
        }
        // 2. 旧版本上传的附件：当时没有落盘，只能看文件名
        if (!attachment.id) {
          placeEmpty('这个附件是旧版本上传的，本机没有保存原文件，无法预览。');
          return;
        }
        placeEmpty('正在读取文件内容…');
        try {
          const payload = await ctx.kit.requestJson(`/attachments/${attachment.id}/text`, {
            timeout: PREVIEW_TIMEOUT
          });
          const text = String((payload && payload.text) || '');
          const truncated = Boolean(payload && payload.truncated);
          meta.textContent = `${label} · ${ctx.kit.formatFileSize(attachment.size)}${
            truncated ? ` · 内容较长，仅展示前 ${DOC_PREVIEW_CHARS} 字` : ''
          }`;
          if (!text) {
            placeEmpty('这个文件里没有抽取到文字（可能是扫描件或纯图片内容），可以「用系统程序打开」查看。');
            return;
          }
          body.textContent = '';
          body.appendChild(h('pre', { text }));
        } catch (error) {
          placeEmpty(ctx.kit.friendlyError(error));
        }
      }

      let cachedBase64 = '';
      async function base64Of() {
        if (attachment.base64) {
          return attachment.base64;
        }
        if (attachment.localKey || !attachment.id) {
          return '';
        }
        if (!cachedBase64) {
          cachedBase64 = await blobToBase64(await ctx.kit.fetchAttachmentBlob(attachment.id, 60000));
        }
        return cachedBase64;
      }

      async function act(kind) {
        // 大附件一次就是几十 MB 的 base64 走 IPC：连点会重复下载，按钮也不该一直可点
        openButton.disabled = true;
        saveButton.disabled = true;
        try {
          const base64 = await base64Of();
          if (!base64) {
            ctx.toast('这个附件没有可用的原文件，可能已被清理', 'error');
            return;
          }
          const payload = { name: attachment.name, base64 };
          const result =
            kind === 'open'
              ? await ctx.bridge.openAttachment(payload)
              : await ctx.bridge.saveAttachment(payload);
          if (result && result.error) {
            ctx.toast(result.error, 'error');
            return;
          }
          if (kind === 'save' && result && result.saved) {
            ctx.toast(`已保存：${result.name}`);
          }
        } catch (error) {
          ctx.toast(ctx.kit.friendlyError(error), 'error');
        } finally {
          openButton.disabled = false;
          saveButton.disabled = false;
        }
      }

      openButton.addEventListener('click', () => act('open'));
      saveButton.addEventListener('click', () => act('save'));
      loadText();

      return {
        onEscape() {
          ctx.close();
          return true;
        }
      };
    }
  };
})();
