/**
 * 文件：desktop/src/renderer/views/rename.js
 * 职责：重命名会话窗口——窗口自己发 PATCH，成功后把 { id, title } 回传主窗口刷新列表。
 * 载荷：{ id, title }
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  window.SXW_VIEWS.rename = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const payload = ctx.payload || {};
      const input = h('input', {
        class: 'auth-input',
        type: 'text',
        maxlength: 60,
        placeholder: '给这个会话起个名字'
      });
      const tip = h('p', { class: 'auth-tip', hidden: true });
      const cancel = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const ok = h('button', { class: 'btn-primary', type: 'button', text: '保存' });

      const setTip = (text) => {
        tip.textContent = text || '';
        tip.hidden = !text;
        tip.classList.toggle('is-error', Boolean(text));
      };

      root.appendChild(
        h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' }, [
          // 窗口名已在标题栏，卡片里直接给输入框
          h('label', { class: 'auth-field' }, [h('span', { class: 'auth-label', text: '标题' }), input]),
          tip,
          h('div', { class: 'modal-actions' }, [cancel, ok])
        ])
      );

      input.value = payload.title || '';
      input.focus();
      input.select();

      let busy = false;
      async function submit() {
        if (busy) {
          return;
        }
        const title = input.value.trim();
        if (!title) {
          setTip('标题不能为空');
          input.focus();
          return;
        }
        busy = true;
        ok.disabled = true;
        // 请求在途时锁窗：PATCH 已落库但窗口被关，结果发不出去，侧栏标题就会和库不一致
        if (typeof ctx.setClosable === 'function') {
          ctx.setClosable(false);
        }
        try {
          const body = await ctx.kit.requestJson(`/conversations/${payload.id}`, {
            method: 'PATCH',
            json: { title }
          });
          ctx.result({ action: 'renamed', id: payload.id, title: (body && body.title) || title });
          ctx.close();
        } catch (error) {
          setTip(ctx.kit.friendlyError(error));
        } finally {
          busy = false;
          ok.disabled = false;
          if (typeof ctx.setClosable === 'function') {
            ctx.setClosable(true);
          }
        }
      }

      ok.addEventListener('click', submit);
      cancel.addEventListener('click', () => ctx.close());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      input.addEventListener('input', () => setTip(''));

      return {
        onEscape() {
          ctx.close();
          return true;
        }
      };
    }
  };
})();
