/**
 * 文件：desktop/src/renderer/views/nickname.js
 * 职责：修改昵称窗口——PATCH /me 成功后把新昵称写回加密登录态，主窗口收到广播自己刷新卡片。
 * 载荷：{ nickname }
 * 回传：{ action: 'saved', nickname }
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const NICKNAME_MAX = 20; // 与后端 schemas/user.py 的 NICKNAME_MAX 同源

  window.SXW_VIEWS.nickname = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const payload = ctx.payload || {};
      const input = h('input', {
        class: 'auth-input',
        type: 'text',
        maxlength: NICKNAME_MAX,
        placeholder: '1-20 个字符'
      });
      const tip = h('p', { class: 'auth-tip', hidden: true });
      const cancel = h('button', { class: 'btn-ghost', type: 'button', text: '取消' });
      const ok = h('button', { class: 'btn-primary', type: 'button', text: '保存' });

      root.appendChild(
        h('div', { class: 'modal-card modal-card-sm', role: 'dialog', 'aria-modal': 'true' }, [
          // 窗口名已在标题栏，卡片里直接给输入框
          h('label', { class: 'auth-field' }, [h('span', { class: 'auth-label', text: '昵称' }), input]),
          tip,
          h('div', { class: 'modal-actions' }, [cancel, ok])
        ])
      );

      input.value = payload.nickname || '';
      input.focus();
      input.select();

      const setTip = (text) => {
        tip.textContent = text || '';
        tip.hidden = !text;
        tip.classList.toggle('is-error', Boolean(text));
      };

      let busy = false;
      async function submit() {
        if (busy) {
          return;
        }
        const nickname = input.value.trim();
        if (!nickname) {
          setTip('请填写昵称');
          return;
        }
        if (nickname.length > NICKNAME_MAX) {
          setTip(`昵称最多 ${NICKNAME_MAX} 个字符`);
          return;
        }
        busy = true;
        ok.disabled = true;
        try {
          const body = await ctx.kit.requestJson('/me', { method: 'PATCH', json: { nickname } });
          const user = ctx.kit.jsonPayload(body) || {};
          const next = String(user.nickname || nickname);
          // 落盘那份也改：否则重启后又变回旧昵称
          const auth = (await ctx.bridge.readAuth()) || {};
          if (auth.token) {
            await ctx.bridge
              .writeAuth({
                token: auth.token,
                id: auth.id,
                username: auth.username,
                nickname: next,
                avatar: auth.avatar
              })
              .catch(() => {});
          }
          ctx.result({ action: 'saved', nickname: next });
          ctx.close();
        } catch (error) {
          setTip(ctx.kit.friendlyError(error));
        } finally {
          busy = false;
          ok.disabled = false;
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
