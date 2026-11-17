/**
 * 文件：desktop/src/renderer/connection.js
 * 职责：连接态与侧栏占位的唯一协调层——骨架条 / 离线占位 / 真实列表三态的切换，
 *      以及「数据源整份换掉」（换接口地址 / 换库 / 恢复 / 清除）后的统一复位与跨窗口跟随。
 *
 * 为什么单独成文件：这些判断原先散在 setConnection、设置弹窗、storage 回调三处，
 * 每处各写一遍「清空 + 重画」，漏一处就出现下面这些症状（本文件就是为根治它们而拆出来的）：
 *   - 点「检测连接」后侧栏被清成离线占位，检测成功又铺成无限动画骨架
 *     （conversationsLoaded 已是 true，没有任何路径再重拉列表）
 *   - 空态「还没有对话」被离线占位盖掉，连接恢复后再也回不到空态
 *   - 改了接口地址仍显示旧地址的会话（缓存标志没失效）
 * 三个状态只有一个出口：refreshPlaceholder()。
 *
 * 导出约定与 storage.js / models.js 一致：工厂函数 + module.exports / window.SXW* 双出口。
 */
(function (global) {
  'use strict';

  function createConnectionDomain(deps) {
    const state = deps.state;
    const dom = deps.dom;
    const skeletonRows = deps.skeletonRows || 3;
    const renderSessionList = deps.renderSessionList;
    const showEmptyState = deps.showEmptyState;
    const runAsync = deps.runAsync;
    const checkConnection = deps.checkConnection;
    const loadModels = deps.loadModels;
    const getConfig = deps.getConfig || (() => ({}));
    const mergeConfig = deps.mergeConfig || (() => ({}));
    const stopGenerating = deps.stopGenerating || (() => {});

    function renderSkeleton() {
      dom['session-list'].innerHTML = '';
      for (let index = 0; index < skeletonRows; index += 1) {
        const bar = document.createElement('div');
        bar.className = 'session-skeleton is-loading';
        dom['session-list'].appendChild(bar);
      }
    }

    // 只开关动画，不重建节点：状态没变时反复 toggle 不会引起重排
    function updateAnimation(loading) {
      dom['session-list'].querySelectorAll('.session-skeleton').forEach((bar) => {
        bar.classList.toggle('is-loading', Boolean(loading));
      });
    }

    // 离线占位：连不上后端时不留骨架条，给一句明白话。
    // 状态没变就不重建，免得自动轮询每 5 秒闪一次
    function renderOffline() {
      const list = dom['session-list'];
      const connecting = state.retrying || state.online === null;
      const existing = list.querySelector('.session-offline');
      if (existing && existing.dataset.state === String(connecting)) {
        return;
      }
      list.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'session-offline';
      box.dataset.state = String(connecting);
      const text = document.createElement('p');
      text.className = 'session-offline-text';
      text.textContent = connecting ? '正在连接后端…' : '后端连接失败，暂时看不到历史会话';
      box.appendChild(text);
      list.appendChild(box);
    }

    /**
     * 侧栏三态的唯一出口：真实列表/空态 > 离线占位 > 骨架。
     *
     * 关键约束一：只要已有会话条目或「还没有对话」，任何连接态变化都不许把它们盖掉。
     * 关键约束二：数据已加载（conversationsLoaded）时按内存数据落真态，绝不再铺骨架——
     *   骨架的 is-loading 是 infinite 动画，一旦铺上又没有路径重拉，就会永远转下去。
     */
    function refreshPlaceholder() {
      const list = dom['session-list'];
      const hasRows = Boolean(list.querySelector('.session-item') || list.querySelector('.session-empty'));
      if (state.online !== true) {
        // 断线时只保留「真实会话」：空态（包括页面初始那条「还没有对话」）说明这条数据源还没读到东西，
        // 继续留着它只会让人以为列表真为空，换成「后端连接失败」占位更能说明问题。
        // 判断同时看内存数据：DOM 里的初始空态不等于「已经确认没有会话」。
        const hasRealRows = Boolean(list.querySelector('.session-item')) || state.conversations.length > 0;
        if (hasRealRows) {
          list.querySelectorAll('.session-skeleton').forEach((bar) => bar.remove());
          return;
        }
        renderOffline();
        return;
      }
      if (hasRows) {
        return;
      }
      if (state.conversationsLoaded) {
        renderSessionList();
        return;
      }
      if (!list.querySelector('.session-skeleton')) {
        renderSkeleton();
      }
    }

    /**
     * 数据源整份换掉（换接口地址 / 换库 / 恢复 / 清除）后统一复位。
     * 四个入口共用这一份，避免「某处忘了清 conversationsLoaded」导致旧会话或骨架常驻。
     */
    function resetAfterDataSwap() {
      // 先停流再清状态：反过来的话，旧请求的收尾回调会把「刚清空的会话」又写回界面
      stopGenerating();
      state.conversationsLoaded = false;
      state.modelsChecked = false;
      state.conversationId = null;
      state.conversations = [];
      state.conversationsHasMore = false;
      state.conversationsPaged = false;
      state.conversationsLoadingMore = false;
      renderSessionList();
      showEmptyState();
    }

    // 其它窗口改了接口地址 / 换了库 / 增删模型：主窗口不能等下一轮轮询（最长 15 秒）才发现，
    // 否则会话列表、模型下拉与连接态会长时间停在旧数据上
    function bind() {
      const bridge = global.desktopBridge;
      if (!bridge) {
        return;
      }
      if (typeof bridge.onBackendRestarted === 'function') {
        bridge.onBackendRestarted(() => {
          resetAfterDataSwap();
          runAsync('刷新后端连接', () => checkConnection());
        });
      }
      if (typeof bridge.onConfigChanged === 'function') {
        bridge.onConfigChanged((conf) => {
          if (!conf || typeof conf !== 'object') {
            return;
          }
          const before = getConfig().apiBase;
          const merged = mergeConfig(conf);
          // 别人改了接口地址：旧地址的会话不认，并立刻按新地址重探，不等下一轮轮询
          if (merged.apiBase !== before) {
            resetAfterDataSwap();
            runAsync('刷新后端连接', () => checkConnection());
          }
        });
      }
      if (typeof bridge.onModelsChanged === 'function') {
        bridge.onModelsChanged(() => {
          state.modelsChecked = false;
          runAsync('刷新模型列表', () => loadModels({ quiet: true }));
        });
      }
    }

    return { refreshPlaceholder, updateAnimation, resetAfterDataSwap, bind };
  }

  const api = { createConnectionDomain };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SXWConnection = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
