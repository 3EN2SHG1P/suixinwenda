// 文件：desktop/src/renderer/ui-bits.js
// 职责：纯渲染碎片——通知图标与消息操作条图标（SVG 的唯一出处）。
// 不碰 DOM 状态、不发请求，app.js 直接取 window.SXW_UI 使用；抽出来是为了 app.js 不再继续膨胀。
(function () {
  'use strict';

  // 通知图标：成功对勾 / 失败感叹 / 信息圆点，全部走 currentColor 描边
  const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5"/><path d="M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.4"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5L21 20H3z"/><path d="M12 10v4.2"/><path d="M12 17.2v.4"/></svg>',
  };

  // 消息操作条图标：与通知同一套 1.7 描边
  const ACTION_ICONS = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14"/></svg>',
    speak:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M15 9.7a3.4 3.4 0 0 1 0 4.6"/><path d="M17.8 7.2a7 7 0 0 1 0 9.6"/></svg>',
    regen:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 5v6h-6"/></svg>',
  };

  // ---- 按钮就地反馈：复制成功 / 保存成功，都不弹通知，改文案或图标后自动复原 ----
  const COPY_FEEDBACK_MS = 1200;
  const copyTimers = new WeakMap(); // 连点时清掉上一个计时器，避免复原错乱
  const copyIcons = new WeakMap(); // 图标按钮的原始 SVG：反馈结束要原样换回来

  function flashCopy(button, ok) {
    if (!button) {
      return;
    }
    const previous = copyTimers.get(button);
    if (previous) {
      window.clearTimeout(previous);
    }
    // 图标按钮不能改 textContent：那会把 SVG 永久抹掉（改回文案时图标也回不来）
    if (button.classList.contains('is-ico')) {
      if (!copyIcons.has(button)) {
        copyIcons.set(button, button.innerHTML);
      }
      const icon = copyIcons.get(button);
      button.innerHTML = ok ? TOAST_ICONS.success : icon;
      button.title = ok ? '已复制' : '复制失败';
      button.classList.toggle('is-done', Boolean(ok));
      copyTimers.set(
        button,
        window.setTimeout(() => {
          button.innerHTML = icon;
          button.title = '复制';
          button.classList.remove('is-done');
          copyTimers.delete(button);
        }, COPY_FEEDBACK_MS)
      );
      return;
    }
    if (!button.dataset.label) {
      button.dataset.label = button.textContent;
    }
    button.textContent = ok ? '已复制' : '复制失败';
    button.classList.toggle('is-done', Boolean(ok));
    copyTimers.set(
      button,
      window.setTimeout(() => {
        button.textContent = button.dataset.label;
        button.classList.remove('is-done');
        copyTimers.delete(button);
      }, COPY_FEEDBACK_MS)
    );
  }

  /** 普通按钮的短反馈：把文案改成「已保存」之类的短词，1.2s 后复原 */
  function flashLabel(button, label, ms) {
    if (!button) {
      return;
    }
    if (!button.dataset.label) {
      button.dataset.label = button.textContent;
    }
    button.textContent = label;
    window.clearTimeout(button._labelTimer);
    button._labelTimer = window.setTimeout(() => {
      button.textContent = button.dataset.label;
    }, ms || COPY_FEEDBACK_MS);
  }

  window.SXW_UI = { TOAST_ICONS, ACTION_ICONS, flashCopy, flashLabel };
})();
