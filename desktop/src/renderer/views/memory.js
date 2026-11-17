/**
 * 文件：desktop/src/renderer/views/memory.js
 * 职责：对话历史窗口——展示模型这一轮真正看到的上下文（自动总结 + 最近若干轮），图片可点开大图。
 * 载荷：{ conversationId, title }
 * 复用 renderer/lib/markdown.js：与正文同一套渲染器，只去掉代码块工具条。
 */
(function () {
  'use strict';
  window.SXW_VIEWS = window.SXW_VIEWS || {};

  const MEMORY_TIMEOUT = 60000;

  function memoryHtml(content) {
    return window.SXWMarkdown
      .renderMarkdown(content)
      .replace(/<div class="code-head">[\s\S]*?<\/div>/g, '')
      .replace(/class="code-block is-collapsed"/g, 'class="code-block"');
  }

  window.SXW_VIEWS.memory = {
    mount(root, ctx) {
      const { h } = ctx.kit;
      const body = h('div', { class: 'memory-body' });
      const stats = h('span', { class: 'memory-stats', text: '' });
      const subtitle = h('p', { class: 'memory-sub', text: '' });
      const refreshButton = h('button', { class: 'btn-ghost', type: 'button', text: '刷新' });
      const actions = h('div', { class: 'modal-actions' }, [
        refreshButton,
        h('button', { class: 'btn-primary', type: 'button', text: '关闭' })
      ]);
      let conversationId = (ctx.payload && ctx.payload.conversationId) || null;
      let title = (ctx.payload && ctx.payload.title) || '';
      let seq = 0;
      const objectUrls = new Set();

      root.appendChild(
        h('div', { class: 'modal-card modal-card-wide', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { class: 'memory-head' }, [
            h('h3', { class: 'modal-title', text: '对话历史' }),
            stats
          ]),
          subtitle,
          body,
          actions
        ])
      );
      actions.querySelector('.btn-primary').addEventListener('click', () => ctx.close());
      // 刷新：同一个会话里继续聊了几轮，窗口不用关掉重开（模型看到的上下文已经变了）
      refreshButton.addEventListener('click', () => {
        if (refreshButton.disabled) {
          return;
        }
        refreshButton.disabled = true;
        load().then(() => {
          refreshButton.disabled = false;
        });
      });

      /** 顶部两行：会话标题 + 一句口径说明（标题来自主窗口，切会话时会更新）。 */
      function syncHead() {
        stats.textContent = '';
        subtitle.textContent = `模型这一轮实际看到的上下文${title ? ` · ${title}` : ''}：自动总结的摘要 + 最近若干轮对话，只带图片缩略图，不跨会话。`;
      }
      syncHead();

      function placeEmpty(text) {
        body.textContent = '';
        body.appendChild(h('p', { class: 'memory-empty', text }));
      }

      function renderImages(row, images) {
        const list = Array.isArray(images) ? images.filter((image) => image && image.id) : [];
        if (!list.length) {
          return;
        }
        const strip = h('div', { class: 'memory-images' });
        list.forEach((image) => {
          const name = String(image.name || '图片');
          const replayed = Boolean(image.replayed);
          const thumb = h('button', {
            class: replayed ? 'memory-thumb' : 'memory-thumb is-muted',
            type: 'button',
            title: replayed ? `${name}（这一轮已重放给模型）` : `${name}（超出重放窗口，这一轮模型没看到它）`
          });
          const img = h('img', { alt: name });
          thumb.appendChild(img);
          if (!replayed) {
            thumb.appendChild(h('span', { class: 'memory-thumb-tag', text: '未重放' }));
          }
          thumb.addEventListener('click', () => {
            ctx.openWindow('lightbox', {
              attachment: { id: Number(image.id) || 0, name, mime: 'image/png', size: 0 }
            });
          });
          strip.appendChild(thumb);
          ctx.kit
            .fetchAttachmentBlob(image.id, MEMORY_TIMEOUT)
            .then((blob) => {
              if (!thumb.isConnected) {
                return;
              }
              const url = URL.createObjectURL(blob);
              objectUrls.add(url);
              img.src = url;
            })
            .catch(() => {
              if (!img.isConnected) {
                return;
              }
              img.remove();
              thumb.appendChild(h('span', { class: 'memory-thumb-fallback', text: name }));
            });
        });
        row.appendChild(strip);
      }

      function render(data) {
        const messages = data && Array.isArray(data.messages) ? data.messages : [];
        // 重画前先释放上一批缩略图：否则每次刷新/切会话都会把整份图片留在内存里，
        // 直到窗口关闭才释放（历史窗口反复刷新是最常见的长驻增长源）
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
        objectUrls.clear();
        body.textContent = '';
        if (!messages.length) {
          stats.textContent = '';
          // 后端在构建上下文失败时会返回 degraded：这时候说「没有消息」是错的，
          // 用户会以为对话被清空了，而真正原因是库/附件读取出了问题
          placeEmpty(
            data && data.degraded
              ? '读取对话历史时出错，请查看后端日志或稍后重试'
              : '这个会话还没有消息'
          );
          return;
        }
        const summaryCount = messages.filter((item) => item && item.role === 'system').length;
        stats.textContent = `共 ${messages.length} 条 · 摘要 ${summaryCount} 段`;
        messages.forEach((item) => {
          const isSummary = item && item.role === 'system';
          const row = h('div', { class: isSummary ? 'memory-item is-summary' : 'memory-item' });
          row.appendChild(
            h('span', {
              class: 'memory-role',
              text: isSummary ? '自动总结摘要' : item && item.role === 'user' ? '我' : 'AI'
            })
          );
          renderImages(row, item && item.images);
          const text = h('div', { class: 'memory-text markdown-body' });
          const content = item && item.content != null ? String(item.content) : '';
          // 摘要是一段压缩出来的纯文本，按原文显示；用户 / AI 消息按 Markdown 渲染
          if (isSummary || !content) {
            text.textContent = content;
          } else {
            text.innerHTML = memoryHtml(content);
          }
          row.appendChild(text);
          body.appendChild(row);
        });
      }

      async function load() {
        if (!conversationId) {
          stats.textContent = '';
          placeEmpty('还没有打开对话，先点一个会话再查看对话历史');
          return;
        }
        seq += 1;
        const current = seq;
        stats.textContent = '读取中…';
        placeEmpty('正在读取…');
        try {
          const payload = await ctx.kit.requestJson(`/conversations/${conversationId}/memory`, {
            timeout: MEMORY_TIMEOUT
          });
          if (current === seq) {
            render(payload);
          }
        } catch (error) {
          if (current === seq) {
            placeEmpty(ctx.kit.friendlyError(error));
          }
        }
      }

      load();

      return {
        onPayload(payload) {
          const next = (payload && payload.conversationId) || null;
          if (!next) {
            return;
          }
          // 标题跟着会话变：换会话后顶部那句「模型这一轮看到了什么 · 某会话」必须更新
          title = (payload && payload.title) || title;
          syncHead();
          if (next === conversationId) {
            return;
          }
          conversationId = next;
          load();
        },
        onEscape() {
          ctx.close();
          return true;
        },
        destroy() {
          objectUrls.forEach((url) => {
            try {
              URL.revokeObjectURL(url);
            } catch (error) {
              // 已释放的 URL 再 revoke 不影响
            }
          });
          objectUrls.clear();
        }
      };
    }
  };
})();
