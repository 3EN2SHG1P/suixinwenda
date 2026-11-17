/**
 * 文件：desktop/test/connection-domain.test.js
 * 职责：连接域（connection.js）的侧栏三态与数据源复位逻辑。
 *
 * 为什么值得单测：这里最贵的错是「骨架条无限转」和「空态被离线占位盖掉」——
 * 两者都不抛异常、控制台一片干净，只有盯着侧栏才会发现，而它们恰好是用户最容易撞到的路径
 * （点一次「检测连接」、后端晚启动几秒、改完接口地址）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createConnectionDomain } = require('../src/renderer/connection.js');

// 骨架条是 createElement 出来的：给一个最小实现，够断言节点数量与 class 即可
global.document = {
  createElement: () => makeNode()
};

function makeNode(className) {
  const node = {
    className: className || '',
    textContent: '',
    dataset: {},
    children: [],
    parent: null,
    classList: {
      toggle(name, on) {
        const set = new Set(String(node.className).split(/\s+/).filter(Boolean));
        if (on) {
          set.add(name);
        } else {
          set.delete(name);
        }
        node.className = Array.from(set).join(' ');
      }
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (!node.parent) {
        return;
      }
      const index = node.parent.children.indexOf(node);
      if (index >= 0) {
        node.parent.children.splice(index, 1);
      }
    }
  };
  return node;
}

function matches(node, selector) {
  const name = selector.replace(/^\./, '');
  return String(node.className || '')
    .split(/\s+/)
    .includes(name);
}

function makeList(children) {
  const list = makeNode('');
  list.children = children || [];
  list.children.forEach((child) => {
    child.parent = list;
  });
  list.innerHTML = '';
  Object.defineProperty(list, 'innerHTML', {
    get: () => '',
    set: () => {
      list.children = [];
    }
  });
  list.querySelector = (selector) => list.children.find((child) => matches(child, selector)) || null;
  list.querySelectorAll = (selector) => list.children.filter((child) => matches(child, selector));
  return list;
}

function makeDeps(overrides) {
  const list = (overrides && overrides.list) || makeList();
  const calls = { renderSessionList: 0, showEmptyState: 0, checkConnection: 0, loadModels: 0 };
  const state = Object.assign(
    {
      online: null,
      retrying: false,
      conversations: [],
      conversationsLoaded: false,
      conversationsHasMore: false,
      conversationsPaged: false,
      conversationsLoadingMore: false,
      conversationId: 7,
      modelsChecked: true
    },
    (overrides && overrides.state) || {}
  );
  let config = Object.assign({ apiBase: 'http://127.0.0.1:8010' }, (overrides && overrides.config) || {});
  const deps = {
    state,
    dom: { 'session-list': list },
    skeletonRows: 3,
    renderSessionList: () => {
      calls.renderSessionList += 1;
      // 真实实现会铺出「会话条目 / 还没有对话」；测试里用一条空态代表它已经落回真实列表
      list.children = [makeNode('session-empty')];
      list.children[0].parent = list;
    },
    showEmptyState: () => {
      calls.showEmptyState += 1;
    },
    runAsync: (label, task) => task(),
    checkConnection: async () => {
      calls.checkConnection += 1;
      return true;
    },
    loadModels: async () => {
      calls.loadModels += 1;
    },
    getConfig: () => config,
    mergeConfig: (patch) => {
      config = Object.assign({}, config, patch);
      return config;
    }
  };
  return { deps, state, list, calls };
}

test('点过「检测连接」后不会留下无限动画骨架：已加载就直接落回真实列表', () => {
  const list = makeList([makeNode('session-offline')]);
  const { deps, state, calls } = makeDeps({ list });
  state.online = true;
  state.conversationsLoaded = true;

  createConnectionDomain(deps).refreshPlaceholder();

  assert.strictEqual(calls.renderSessionList, 1, 'conversationsLoaded 为真时按内存数据落真态');
  assert.strictEqual(list.querySelector('.session-skeleton'), null, '不许再铺骨架');
});

test('在线且已有「还没有对话」空态时不动它', () => {
  const list = makeList([makeNode('session-empty')]);
  const { deps, state, calls } = makeDeps({ list });
  state.online = true;
  state.conversationsLoaded = true;

  createConnectionDomain(deps).refreshPlaceholder();

  assert.strictEqual(calls.renderSessionList, 0);
  assert.ok(list.querySelector('.session-empty'));
});

test('离线时保留真实会话，不拿离线占位盖掉', () => {
  const list = makeList([makeNode('session-item')]);
  const { deps, state } = makeDeps({ list });
  state.online = false;
  state.conversations = [{ id: 1 }];

  createConnectionDomain(deps).refreshPlaceholder();

  assert.ok(list.querySelector('.session-item'));
  assert.strictEqual(list.querySelector('.session-offline'), null);
});

test('离线时初始空态要换成离线占位（否则看起来像「真的没有会话」）', () => {
  const list = makeList([makeNode('session-empty')]);
  const { deps, state } = makeDeps({ list });
  state.online = false;

  createConnectionDomain(deps).refreshPlaceholder();

  assert.strictEqual(list.querySelector('.session-empty'), null);
  assert.ok(list.querySelector('.session-offline'));
});

test('离线且无内容时给明白话占位，检测中显示「正在连接后端…」', () => {
  const offline = makeDeps({ list: makeList() });
  offline.state.online = false;
  createConnectionDomain(offline.deps).refreshPlaceholder();
  const box = offline.list.querySelector('.session-offline');
  assert.ok(box, '离线要有占位');
  assert.match(box.children[0].textContent, /后端连接失败/);

  const connecting = makeDeps({ list: makeList() });
  connecting.state.online = null;
  createConnectionDomain(connecting.deps).refreshPlaceholder();
  const pending = connecting.list.querySelector('.session-offline');
  assert.match(pending.children[0].textContent, /正在连接后端/);
});

test('在线但还没拉到数据时才铺骨架，并且带加载动画', () => {
  const { deps, state, list } = makeDeps({ list: makeList() });
  state.online = true;
  state.conversationsLoaded = false;

  createConnectionDomain(deps).refreshPlaceholder();

  const bars = list.querySelectorAll('.session-skeleton');
  assert.strictEqual(bars.length, 3);
  bars.forEach((bar) => assert.match(bar.className, /is-loading/));
});

test('数据源整份换掉后，所有「已加载」标志都复位并回到空态', () => {
  const { deps, state, calls } = makeDeps();
  state.conversations = [{ id: 1 }];
  state.conversationsLoaded = true;
  state.conversationsHasMore = true;
  state.conversationsPaged = true;
  state.conversationsLoadingMore = true;
  state.modelsChecked = true;

  createConnectionDomain(deps).resetAfterDataSwap();

  assert.strictEqual(state.conversationsLoaded, false);
  assert.strictEqual(state.modelsChecked, false);
  assert.strictEqual(state.conversationId, null);
  assert.deepStrictEqual(state.conversations, []);
  assert.strictEqual(state.conversationsHasMore, false);
  assert.strictEqual(state.conversationsPaged, false);
  assert.strictEqual(state.conversationsLoadingMore, false);
  assert.strictEqual(calls.renderSessionList, 1);
  assert.strictEqual(calls.showEmptyState, 1);
});

test('其它窗口换了后端：主窗口复位并立刻重探，不等轮询', () => {
  const { deps, state, calls } = makeDeps();
  state.conversationsLoaded = true;
  let restarted = null;
  globalThis.desktopBridge = {
    onBackendRestarted: (handler) => {
      restarted = handler;
    }
  };
  try {
    createConnectionDomain(deps).bind();
    assert.strictEqual(typeof restarted, 'function', '必须订阅换库广播');
    restarted();
    assert.strictEqual(state.conversationsLoaded, false);
    assert.strictEqual(calls.checkConnection, 1);
  } finally {
    delete globalThis.desktopBridge;
  }
});

test('其它窗口改了接口地址：旧地址的会话立刻作废', () => {
  const { deps, state } = makeDeps();
  state.conversationsLoaded = true;
  let changed = null;
  globalThis.desktopBridge = {
    onConfigChanged: (handler) => {
      changed = handler;
    }
  };
  try {
    createConnectionDomain(deps).bind();
    changed({ apiBase: 'http://127.0.0.1:9020' });
    assert.strictEqual(state.conversationsLoaded, false);
  } finally {
    delete globalThis.desktopBridge;
  }
});
