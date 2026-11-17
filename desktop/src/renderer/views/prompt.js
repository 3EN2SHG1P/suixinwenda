/**
 * 文件：desktop/src/renderer/views/prompt.js
 * 职责：提示词库窗口——本机保存常用提问模板；支持搜索、复制到剪贴板、删除。
 *
 * 为什么要有这扇窗：验证「新增窗口只做两件事」的扩展口径。
 * 这里只写自己的界面与数据（localStorage），不碰标题栏、拖动、缩放、置顶、位置记忆、
 * 主题字号跟随、Esc 关闭、重复触发只聚焦——这些全部由 app-window.js + app-windows.js 提供。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const STORE_KEY = 'sxw.prompts';
  const MAX_ITEMS = 100;
  const MAX_TEXT = 2000;

  const DEFAULTS = [
    { id: 'p-review', title: '代码审查', text: '请逐行审查这段代码，指出潜在的 bug、边界条件与可读性问题，并给出修改建议。' },
    { id: 'p-summary', title: '长文摘要', text: '把下面的内容压缩成 5 条要点，每条不超过 30 字，保留数字与结论。' },
    { id: 'p-sql', title: 'SQL 优化', text: '分析这条 SQL 的执行计划风险，说明可能缺的索引，并给出改写后的版本。' }
  ];

  function readStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (Array.isArray(raw)) {
        return raw.filter((item) => item && item.title && item.text);
      }
    } catch (error) {
      // 损坏的本地数据不该让窗口打不开
    }
    return DEFAULTS.slice();
  }

  function writeStore(items) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    } catch (error) {
      // 存不下就只在本次会话里生效
    }
  }

  window.SXW_VIEWS.prompt = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      let items = readStore();
      let keyword = '';

      const search = h('input', { class: 'auth-input', type: 'text', placeholder: '搜索标题或内容' });
      const list = h('div', { class: 'prompt-list' });
      const empty = h('p', { class: 'settings-hint', text: '还没有提示词。' });
      const titleInput = h('input', { class: 'auth-input', type: 'text', placeholder: '标题，例如「日报模板」' });
      const textInput = h('textarea', { class: 'auth-input prompt-text', rows: 3, placeholder: '提示词正文' });
      const addButton = h('button', { class: 'btn-primary', type: 'button', text: '添加' });

      root.appendChild(
        h('div', { class: 'modal-card aw-card prompt-window', role: 'dialog', 'aria-modal': 'true' }, [
          // 窗口名已在标题栏，卡片里只留这句说明
          h('p', {
            class: 'settings-hint',
            text: '本机保存，不上传。复制后回到聊天窗口粘贴即可；这扇窗不依赖后端，离线也能用。'
          }),
          h('div', { class: 'prompt-toolbar' }, [search]),
          list,
          empty,
          h('div', { class: 'prompt-form' }, [
            h('div', { class: 'prompt-form-row' }, [titleInput, addButton]),
            textInput
          ])
        ])
      );

      function visible() {
        const key = keyword.trim().toLowerCase();
        if (!key) {
          return items;
        }
        return items.filter(
          (item) => item.title.toLowerCase().includes(key) || item.text.toLowerCase().includes(key)
        );
      }

      async function copy(text) {
        try {
          await navigator.clipboard.writeText(text);
          ctx.toast('已复制到剪贴板');
        } catch (error) {
          ctx.toast('复制失败，请手动选中文本', 'error');
        }
      }

      function render() {
        const rows = visible().sort((a, b) => (a.title > b.title ? 1 : -1));
        list.textContent = '';
        empty.hidden = rows.length > 0;
        rows.forEach((item) => {
          const row = h('div', { class: 'prompt-item' }, [
            h('div', { class: 'prompt-item-main' }, [
              h('b', { class: 'prompt-item-title', text: item.title }),
              h('p', { class: 'prompt-item-text', text: item.text })
            ])
          ]);
          const actions = h('span', { class: 'prompt-item-actions' });
          const copyButton = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: '复制' });
          copyButton.addEventListener('click', () => copy(item.text));
          const removeButton = h('button', { class: 'btn-ghost btn-sm', type: 'button', text: '删除' });
          removeButton.addEventListener('click', () => {
            items = items.filter((entry) => entry.id !== item.id);
            writeStore(items);
            render();
            ctx.toast('已删除');
          });
          actions.append(copyButton, removeButton);
          row.append(actions);
          list.appendChild(row);
        });
      }

      search.addEventListener('input', () => {
        keyword = search.value;
        render();
      });

      addButton.addEventListener('click', () => {
        const title = titleInput.value.trim();
        const text = textInput.value.trim();
        if (!title || !text) {
          ctx.toast('标题和正文都要填', 'error');
          return;
        }
        if (text.length > MAX_TEXT) {
          ctx.toast(`正文最多 ${MAX_TEXT} 字`, 'error');
          return;
        }
        items = [{ id: `p-${Date.now()}`, title, text }, ...items].slice(0, MAX_ITEMS);
        writeStore(items);
        titleInput.value = '';
        textInput.value = '';
        render();
        ctx.toast('已添加');
      });

      titleInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          addButton.click();
        }
      });

      render();
      search.focus();

      return {
        onEscape() {
          // 输入框里有内容时先清空，再按一次才关窗：和「一屏一个主要动作」一致
          if (titleInput.value || textInput.value || keyword) {
            titleInput.value = '';
            textInput.value = '';
            keyword = '';
            search.value = '';
            render();
            return true;
          }
          ctx.close();
          return true;
        }
      };
    }
  };
})();
