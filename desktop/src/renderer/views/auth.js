/**
 * 文件：desktop/src/renderer/views/auth.js
 * 职责：登录 / 注册窗口——只收集账号密码并做本地必填校验；真正的请求、匿名会话认领、列表刷新
 *      仍在主窗口完成（那条链路依赖 state.conversations 与 state.auth，复制一份必然漂移）。
 * 载荷：{ username }
 * 回传：{ action: 'submit', tab, username, password, remember, nickname }
 * 答复：{ ok: true } 关闭窗口 / { ok: false, error } 原位提示
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const TABS = ['password', 'register'];

  function passwordHintOf(password) {
    if (!password) {
      return '';
    }
    if (/^\d+$/.test(password)) {
      return '纯数字密码很容易被猜到，建议混入字母';
    }
    if (password.length < 8) {
      return '建议 8 位以上，更安全';
    }
    return '';
  }

  window.SXW_VIEWS.auth = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const payload = ctx.payload || {};
      let tab = 'password';
      let busy = false;

      const tip = h('p', { class: 'auth-tip', hidden: true });
      // 卡片里不再放与标题栏同名的大标题：切到注册时改窗口标题，信息不丢也不重复
      const sub = h('p', { class: 'auth-sub', text: '账号密码登录；第一次用先切到「注册」创建账号' });
      const tabLogin = h('button', { class: 'auth-tab is-active', type: 'button', text: '登录' });
      const tabRegister = h('button', { class: 'auth-tab', type: 'button', text: '注册' });

      const username = h('input', {
        class: 'auth-input',
        type: 'text',
        placeholder: '3-50 位，中文/字母/数字/_ . @ + -'
      });
      const password = h('input', { class: 'auth-input', type: 'password', placeholder: '6-64 位' });
      const passwordToggle = h('button', { class: 'btn-ghost auth-inline-btn', type: 'button', text: '显示' });
      const passwordHint = h('span', { class: 'auth-hint', hidden: true });
      const password2 = h('input', { class: 'auth-input', type: 'password', placeholder: '再输一次' });
      const nickname = h('input', { class: 'auth-input', type: 'text', maxlength: 20, placeholder: '不填就用账号名' });
      const remember = h('input', { type: 'checkbox', checked: true });
      const submit = h('button', { class: 'btn-primary auth-submit', type: 'button', text: '登录' });
      const guest = h('button', { class: 'auth-link', type: 'button', text: '以访客身份使用' });

      const fieldPassword2 = h('label', { class: 'auth-field', hidden: true }, [
        h('span', { class: 'auth-label', text: '确认密码' }),
        password2
      ]);
      const fieldNickname = h('label', { class: 'auth-field', hidden: true }, [
        h('span', { class: 'auth-label', text: '昵称（选填）' }),
        nickname
      ]);

      root.appendChild(
        h('div', { class: 'auth-shell', role: 'dialog', 'aria-modal': 'true' }, [
          h('section', { class: 'auth-panel' }, [
            sub,
            h('div', { class: 'auth-tabs' }, [tabLogin, tabRegister]),
            h('label', { class: 'auth-field' }, [h('span', { class: 'auth-label', text: '账号' }), username]),
            h('label', { class: 'auth-field' }, [
              h('span', { class: 'auth-label', text: '密码' }),
              h('span', { class: 'auth-input-row' }, [password, passwordToggle]),
              passwordHint
            ]),
            fieldPassword2,
            fieldNickname,
            h('label', { class: 'auth-remember' }, [remember, h('span', { text: '记住我（下次启动免登录）' })]),
            tip,
            submit,
            h('div', { class: 'auth-foot' }, [guest, h('span', { text: '忘记密码只能重置本机数据，请妥善保管' })])
          ])
        ])
      );

      username.value = payload.username || '';

      const setTip = (text) => {
        tip.textContent = text || '';
        tip.hidden = !text;
        tip.classList.toggle('is-error', Boolean(text));
      };

      function switchTab(name) {
        tab = name;
        TABS.forEach((item) => {
          const button = item === 'password' ? tabLogin : tabRegister;
          button.classList.toggle('is-active', item === name);
        });
        const isRegister = name === 'register';
        fieldPassword2.hidden = !isRegister;
        fieldNickname.hidden = !isRegister;
        submit.textContent = isRegister ? '注册' : '登录';
        passwordHint.hidden = true;
        ctx.setTitle(isRegister ? '注册随心问答' : '登录随心问答');
        sub.textContent = isRegister
          ? '创建本机账号；注册成功会直接登录，不用再输一次'
          : '账号密码登录；第一次用先切到「注册」创建账号';
        setTip('');
      }

      tabLogin.addEventListener('click', () => switchTab('password'));
      tabRegister.addEventListener('click', () => switchTab('register'));
      passwordToggle.addEventListener('click', () => {
        const visible = password.type === 'text';
        password.type = visible ? 'password' : 'text';
        passwordToggle.textContent = visible ? '显示' : '隐藏';
      });
      password.addEventListener('input', () => {
        const hint = tab === 'register' ? passwordHintOf(password.value) : '';
        passwordHint.textContent = hint;
        passwordHint.hidden = !hint;
      });
      guest.addEventListener('click', () => ctx.close());

      function fail(text) {
        setTip(text);
      }

      submit.addEventListener('click', () => {
        if (busy) {
          return;
        }
        const name = username.value.trim();
        const secret = password.value;
        if (!name) {
          fail('请填写账号');
          username.focus();
          return;
        }
        if (!secret) {
          fail('请填写密码');
          password.focus();
          return;
        }
        if (tab === 'register') {
          if (secret.length < 6) {
            fail('密码至少 6 位');
            return;
          }
          if (password2.value !== secret) {
            fail('两次输入的密码不一致');
            return;
          }
        }
        busy = true;
        submit.disabled = true;
        ctx.result({
          action: 'submit',
          tab,
          username: name,
          password: secret,
          remember: remember.checked,
          nickname: tab === 'register' ? nickname.value.trim() : ''
        });
      });

      // 主窗口处理完给答复：成功就关窗（主窗口会接着刷新卡片与列表），失败在原地显示原因。
      // 收集返回值用于销毁时解绑：视图重挂后旧监听仍在，会让一次答复触发多次处理
      const unsubscribes = [];
      const offReply = ctx.bridge.onReply((data) => {
        const reply = data || {};
        busy = false;
        submit.disabled = false;
        if (reply.ok) {
          ctx.close();
          return;
        }
        fail(reply.error || '登录失败，请稍后重试');
      });
      if (typeof offReply === 'function') {
        unsubscribes.push(offReply);
      }

      username.focus();
      switchTab('password');

      return {
        onEscape() {
          ctx.close();
          return true;
        },
        destroy() {
          unsubscribes.forEach((unsubscribe) => {
            try {
              unsubscribe();
            } catch (error) {
              console.error('[登录] 取消订阅失败', error);
            }
          });
          unsubscribes.length = 0;
        }
      };
    }
  };
})();
