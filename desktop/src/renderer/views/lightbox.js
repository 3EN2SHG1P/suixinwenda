/**
 * 文件：desktop/src/renderer/views/lightbox.js
 * 职责：图片预览窗口——滚轮缩放、拖动平移、另存为、用系统程序打开。
 * 载荷：{ attachment: { id, localKey, name, mime, size, base64 } }
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const ZOOM_STEP = 1.2;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 8;

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

  window.SXW_VIEWS.lightbox = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const attachment = (ctx.payload && ctx.payload.attachment) || {};
      const state = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 };
      let objectUrl = '';

      const image = h('img', { class: 'lightbox-image', alt: '', draggable: false });
      const stage = h('div', { class: 'lightbox-stage' }, [image]);
      const name = h('span', { class: 'lightbox-name', text: attachment.name || '图片' });
      const zoomOut = h('button', { class: 'lightbox-btn', type: 'button', title: '缩小', 'aria-label': '缩小', text: '−' });
      const zoomReset = h('button', { class: 'lightbox-btn', type: 'button', title: '原始大小', 'aria-label': '原始大小', text: '1:1' });
      const zoomIn = h('button', { class: 'lightbox-btn', type: 'button', title: '放大', 'aria-label': '放大', text: '+' });
      const saveButton = h('button', { class: 'lightbox-btn', type: 'button', text: '另存为' });
      const openButton = h('button', { class: 'lightbox-btn', type: 'button', text: '用系统程序打开' });
      const closeButton = h('button', { class: 'lightbox-btn', type: 'button', title: '关闭', 'aria-label': '关闭', text: '×' });

      root.appendChild(
        h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '图片预览' }, [
          stage,
          h('div', { class: 'lightbox-bar' }, [
            name,
            h('span', { class: 'lightbox-actions' }, [zoomOut, zoomReset, zoomIn, saveButton, openButton, closeButton])
          ])
        ])
      );

      function applyTransform() {
        image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
      }

      function setScale(next) {
        state.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        applyTransform();
      }

      setScale(1);

      async function loadImage() {
        try {
          if (attachment.base64) {
            image.src = `data:${attachment.mime || 'image/png'};base64,${attachment.base64}`;
            applyTransform();
            closeButton.focus();
            return;
          }
          if (!attachment.id) {
            throw new Error('这个附件是旧版本上传的，本机没有保存原文件');
          }
          objectUrl = URL.createObjectURL(await ctx.kit.fetchAttachmentBlob(attachment.id, 60000));
          image.src = objectUrl;
          applyTransform();
          closeButton.focus();
        } catch (error) {
          ctx.toast(ctx.kit.friendlyError(error), 'error');
          ctx.close();
        }
      }

      async function base64Of() {
        if (attachment.base64) {
          return attachment.base64;
        }
        if (!attachment.id) {
          return '';
        }
        return blobToBase64(await ctx.kit.fetchAttachmentBlob(attachment.id, 60000));
      }

      async function act(kind) {
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
        }
      }

      zoomIn.addEventListener('click', () => setScale(state.scale * ZOOM_STEP));
      zoomOut.addEventListener('click', () => setScale(state.scale / ZOOM_STEP));
      zoomReset.addEventListener('click', () => {
        state.scale = 1;
        state.x = 0;
        state.y = 0;
        applyTransform();
      });
      saveButton.addEventListener('click', () => act('save'));
      openButton.addEventListener('click', () => act('open'));
      closeButton.addEventListener('click', () => ctx.close());

      stage.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          setScale(state.scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
        },
        { passive: false }
      );
      stage.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) {
          return;
        }
        state.dragging = true;
        state.startX = event.clientX - state.x;
        state.startY = event.clientY - state.y;
        stage.classList.add('is-dragging');
        if (typeof stage.setPointerCapture === 'function') {
          stage.setPointerCapture(event.pointerId);
        }
      });
      stage.addEventListener('pointermove', (event) => {
        if (!state.dragging) {
          return;
        }
        state.x = event.clientX - state.startX;
        state.y = event.clientY - state.startY;
        applyTransform();
      });
      const stopDrag = () => {
        state.dragging = false;
        stage.classList.remove('is-dragging');
      };
      stage.addEventListener('pointerup', stopDrag);
      stage.addEventListener('pointercancel', stopDrag);

      loadImage();

      return {
        onEscape() {
          ctx.close();
          return true;
        },
        destroy() {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = '';
          }
        }
      };
    }
  };
})();
