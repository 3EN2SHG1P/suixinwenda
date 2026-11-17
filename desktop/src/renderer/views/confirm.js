/**
 * 文件：desktop/src/renderer/views/confirm.js
 * 职责：二次确认窗口——只收集「确认 / 取消 / 次要动作」，真正的动作由主窗口执行（闭包还在 app.js 里）。
 * 载荷：{ title, text, okText, note, extraText, danger }
 * 回传：{ action: 'confirm' | 'cancel' | 'extra' }
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  window.SXW_VIEWS.confirm = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const payload = ctx.payload || {};
      const extra = h('button', { class: 'btn-ghost', type: 'button', text: payload.extraText || '导出', hidden: !payload.extraText });
      const cancel = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const ok = h('button', {
        class: payload.danger === false ? 'btn-primary' : 'btn-danger',
        type: 'button',
        text: payload.okText || '确定'
      });
      const note = h('p', { class: 'confirm-note', hidden: !payload.note, text: payload.note || '' });

      root.appendChild(
        h('div', { class: 'modal-card modal-card-520 modal-card-confirm', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { class: 'confirm-body' }, [
            h('h3', { class: 'modal-title', text: payload.title || '请确认' }),
            h('p', { class: 'modal-text', text: payload.text || '' }),
            note
          ]),
          h('div', { class: 'settings-foot' }, [extra, h('span', { class: 'grow' }), cancel, ok])
        ])
      );

      // 危险动作默认焦点在「取消」：误按回车不会直接把数据删了
      cancel.focus();

      ok.addEventListener('click', () => {
        ctx.result({ action: 'confirm' });
        ctx.close();
      });
      cancel.addEventListener('click', () => {
        ctx.result({ action: 'cancel' });
        ctx.close();
      });
      extra.addEventListener('click', () => {
        ctx.result({ action: 'extra' });
        ctx.close();
      });

      return {
        onEscape() {
          ctx.result({ action: 'cancel' });
          ctx.close();
          return true;
        }
      };
    }
  };
})();
