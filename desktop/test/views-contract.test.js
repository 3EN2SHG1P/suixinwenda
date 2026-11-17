/**
 * 文件：desktop/test/views-contract.test.js
 * 职责：独立子窗口视图的「交互契约」测试——按钮在不在、点下去回传什么、失败时提示什么。
 *
 * 为什么需要它：`npm run smoke` 要图形界面、CI 明确不跑，视图层此前完全靠手工验证。
 * 而这些视图最容易坏的地方恰好不是像素，是契约：
 *   - 危险动作的默认焦点跑到「确定」上（误按回车直接删数据）；
 *   - 空标题没被拦住就发请求；
 *   - 请求在途时窗口还能关（PATCH 已落库、结果发不出去，侧栏与库不一致）。
 *
 * 为什么不引入 jsdom：这些视图只用到 createElement / appendChild / classList / dataset /
 * addEventListener / focus 这几个能力，下面的最小 shim 就够；不新增依赖，也不动 package-lock。
 * 断言的是「回传给主窗口的 result 载荷」与「控件状态」，排版由冒烟负责。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

class ShimText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
  }
}

class ShimElement {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this._listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.focused = false;
    this.selected = false;
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this._classes].join(' ');
  }

  get classList() {
    const self = this;
    return {
      add: (name) => self._classes.add(name),
      remove: (name) => self._classes.delete(name),
      contains: (name) => self._classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !self._classes.has(name) : Boolean(force);
        if (next) {
          self._classes.add(name);
        } else {
          self._classes.delete(name);
        }
        return next;
      }
    };
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    return child;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }

  dispatch(type, event) {
    (this._listeners.get(type) || []).forEach((handler) => handler(event || { type }));
  }

  focus() {
    this.focused = true;
  }

  select() {
    this.selected = true;
  }

  blur() {
    this.focused = false;
  }
}

const documentShim = {
  createElement: (tag) => new ShimElement(tag, documentShim),
  createTextNode: (text) => new ShimText(text),
  querySelector: () => null,
  querySelectorAll: () => []
};

global.document = documentShim;
global.window = { windowBridge: {} };

require(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'window-kit.js'));
require(path.join(__dirname, '..', 'src', 'renderer', 'views', 'confirm.js'));
require(path.join(__dirname, '..', 'src', 'renderer', 'views', 'rename.js'));

const kit = global.window.SXW_WIN;
const views = global.window.SXW_VIEWS;

function findAll(root, className, found = []) {
  if (root.nodeType === 1) {
    if (root.className.split(' ').includes(className)) {
      found.push(root);
    }
    root.children.forEach((child) => findAll(child, className, found));
  }
  return found;
}

function byClass(root, className) {
  const hit = findAll(root, className)[0];
  assert.ok(hit, `视图里没有 .${className} 节点`);
  return hit;
}

/**
 * 按主窗口的方式挂载视图：收集回传载荷、关窗次数与锁窗调用。
 * kitOverride 用来替换真实网络请求（视图只依赖 ctx.kit 的这几个方法）。
 */
function mount(name, payload, kitOverride) {
  const root = documentShim.createElement('div');
  const calls = { result: [], close: 0, closable: [] };
  const ctx = {
    kit: kitOverride ? Object.assign({}, kit, kitOverride) : kit,
    payload,
    result: (value) => calls.result.push(value),
    close: () => {
      calls.close += 1;
    },
    setClosable: (flag) => {
      calls.closable.push(flag);
    }
  };
  const handle = views[name].mount(root, ctx);
  return { root, calls, handle };
}

/** 重命名窗口的输入框：modal-card > label.auth-field > [span, input] */
function titleInput(root) {
  return root.children[0].children[0].children[1];
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------- 二次确认窗口 ----------

test('确认窗：危险动作的默认焦点在「取消」，回车不会直接执行', () => {
  const { root } = mount('confirm', { title: '删除会话', text: '不可恢复', danger: true });

  // .btn-ghost 依次是「次要动作」与「取消」，取消固定在最后
  const ghosts = findAll(root, 'btn-ghost');
  assert.strictEqual(byClass(root, 'btn-danger').textContent, '确定');
  assert.strictEqual(ghosts[1].textContent, '取消');
  assert.strictEqual(ghosts[1].focused, true, '焦点必须在取消上');
  assert.strictEqual(byClass(root, 'btn-danger').focused, false);
});

test('确认窗：danger 为 false 时主按钮走主色而非危险色', () => {
  const { root } = mount('confirm', { title: '重命名', danger: false, okText: '保存' });

  assert.deepStrictEqual(findAll(root, 'btn-danger'), []);
  assert.strictEqual(byClass(root, 'btn-primary').textContent, '保存');
});

test('确认窗：主按钮回传 confirm 并关窗', () => {
  const { root, calls } = mount('confirm', { title: '恢复', extraText: '导出' });

  byClass(root, 'btn-danger').dispatch('click');

  assert.deepStrictEqual(calls.result, [{ action: 'confirm' }]);
  assert.strictEqual(calls.close, 1);
});

test('确认窗：次要动作回传 extra，取消回传 cancel', () => {
  const { root, calls } = mount('confirm', { title: '恢复', extraText: '先导出' });

  // .btn-ghost 依次是「次要动作」与「取消」，取消固定在最后
  const ghosts = findAll(root, 'btn-ghost');
  assert.strictEqual(ghosts.length, 2);
  ghosts[0].dispatch('click');
  ghosts[1].dispatch('click');

  assert.deepStrictEqual(calls.result, [{ action: 'extra' }, { action: 'cancel' }]);
  assert.strictEqual(calls.close, 2);
});

test('确认窗：没有次要动作时那个按钮是隐藏的', () => {
  assert.strictEqual(findAll(mount('confirm', { title: '删除' }).root, 'btn-ghost')[0].hidden, true);

  const withExtra = mount('confirm', { title: '删除', extraText: '先导出' });
  const extra = findAll(withExtra.root, 'btn-ghost')[0];
  assert.strictEqual(extra.hidden, false);
  assert.strictEqual(extra.textContent, '先导出');
});

test('确认窗：Esc 等同取消，且事件被吞掉（不再冒泡到主窗口）', () => {
  const { calls, handle } = mount('confirm', { title: '删除' });

  assert.strictEqual(handle.onEscape(), true);
  assert.deepStrictEqual(calls.result, [{ action: 'cancel' }]);
  assert.strictEqual(calls.close, 1);
});

// ---------- 重命名窗口 ----------

test('重命名：回填原标题，并把焦点与选区给输入框', () => {
  const { root } = mount('rename', { id: 7, title: '旧标题' });
  const input = titleInput(root);

  assert.strictEqual(input.value, '旧标题');
  assert.strictEqual(input.focused, true);
  assert.strictEqual(input.selected, true);
});

test('重命名：空标题被拦住，不发请求也不关窗', async () => {
  const requested = [];
  const { root, calls } = mount('rename', { id: 7, title: '   ' }, {
    requestJson: (url) => {
      requested.push(url);
      return Promise.resolve({});
    }
  });

  byClass(root, 'btn-primary').dispatch('click');
  await flush();

  assert.deepStrictEqual(requested, [], '空标题不该发出 PATCH');
  assert.strictEqual(calls.close, 0);
  assert.strictEqual(byClass(root, 'auth-tip').textContent, '标题不能为空');
});

test('重命名：成功后回传服务端标题，请求期间锁窗、结束解锁', async () => {
  const requests = [];
  const { root, calls } = mount('rename', { id: 7, title: '旧标题' }, {
    requestJson: (url, options) => {
      requests.push({ url, options });
      return Promise.resolve({ title: '服务端标题' });
    }
  });
  titleInput(root).value = '新标题';

  byClass(root, 'btn-primary').dispatch('click');
  await flush();

  assert.deepStrictEqual(requests, [
    { url: '/conversations/7', options: { method: 'PATCH', json: { title: '新标题' } } }
  ]);
  assert.deepStrictEqual(calls.result, [{ action: 'renamed', id: 7, title: '服务端标题' }]);
  assert.strictEqual(calls.close, 1);
  assert.deepStrictEqual(calls.closable, [false, true], '在途锁窗、结束解锁');
  assert.strictEqual(byClass(root, 'btn-primary').disabled, false);
});

test('重命名：服务端没回 title 时用输入值兜底', async () => {
  const { root, calls } = mount('rename', { id: 7, title: '旧标题' }, {
    requestJson: () => Promise.resolve(null)
  });
  titleInput(root).value = '  新标题  ';

  byClass(root, 'btn-primary').dispatch('click');
  await flush();

  assert.deepStrictEqual(calls.result, [{ action: 'renamed', id: 7, title: '新标题' }]);
});

test('重命名：失败时提示中文原因，不关窗、按钮恢复可用', async () => {
  const { root, calls } = mount('rename', { id: 7, title: '旧标题' }, {
    requestJson: () => Promise.reject(new Error('标题过长')),
    friendlyError: (error) => error.message
  });
  titleInput(root).value = '新标题';

  byClass(root, 'btn-primary').dispatch('click');
  await flush();

  assert.strictEqual(calls.close, 0, '失败不能关窗，否则用户看不到原因');
  assert.deepStrictEqual(calls.result, []);
  assert.strictEqual(byClass(root, 'auth-tip').textContent, '标题过长');
  assert.strictEqual(byClass(root, 'btn-primary').disabled, false);
});

test('重命名：输入时清掉上一次的错误提示', async () => {
  const { root } = mount('rename', { id: 7, title: '' }, {
    requestJson: () => Promise.reject(new Error('标题过长')),
    friendlyError: (error) => error.message
  });
  titleInput(root).value = '新标题';
  byClass(root, 'btn-primary').dispatch('click');
  await flush();
  assert.strictEqual(byClass(root, 'auth-tip').textContent, '标题过长');

  titleInput(root).dispatch('input');

  assert.strictEqual(byClass(root, 'auth-tip').textContent, '');
  assert.strictEqual(byClass(root, 'auth-tip').hidden, true);
});

test('重命名：Esc 直接关窗，不发请求', () => {
  const { calls, handle } = mount('rename', { id: 7, title: '旧标题' });

  assert.strictEqual(handle.onEscape(), true);
  assert.strictEqual(calls.close, 1);
  assert.deepStrictEqual(calls.result, []);
});
