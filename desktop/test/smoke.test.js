/**
 * 文件：desktop/test/smoke.test.js
 * 职责：守住「冒烟代码不进生产包」这件事本身——它没有运行时症状，
 *      只会在打包后被人翻出 app.asar 里一堆测试入口时才发现，所以必须有断言。
 * 另外压住 smoke.js 的加载期行为：只做依赖注入，不许在 require 阶段碰 DOM。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { mount, createSmokeApi } = require('../src/renderer/smoke.js');

function minimalDeps() {
  return {
    dom: {},
    state: {},
    getConfig: () => ({}),
    constants: { THEME_LIGHT: 'light', THEME_DARK: 'dark' },
    updateComposer() {},
    sendMessage() {},
    stopGenerating() {},
    pickAttachment() {},
    handleMenuAction() {},
    flushDraft() {},
    currentTheme: () => 'light',
    openChatSearch() {},
    runChatSearch() {},
    closeChatSearch() {},
    markdown: () => ({ renderMarkdown: () => '' })
  };
}

test('smoke.js 加载期不碰 DOM，只导出 mount / createSmokeApi', () => {
  assert.strictEqual(typeof mount, 'function');
  assert.strictEqual(typeof createSmokeApi, 'function');
  assert.strictEqual(typeof document, 'undefined', 'Node 环境下没有 document，能在加载期不报错就说明没有依赖 DOM');
});

test('mount 每次都会把自检入口换成新的实现', () => {
  const first = mount(minimalDeps());
  assert.strictEqual(typeof globalThis.__smokeReport, 'function');
  assert.strictEqual(typeof globalThis.__smokeScenario, 'function');
  assert.strictEqual(globalThis.__smokeScenario, first.runSmokeScenario);

  const second = mount(minimalDeps());
  assert.notStrictEqual(globalThis.__smokeScenario, first.runSmokeScenario, '重复挂载必须整体替换，不许留旧闭包');
  assert.strictEqual(globalThis.__smokeReport, second.smokeReport);

  delete globalThis.__smokeReport;
  delete globalThis.__smokeScenario;
});

test('打包配置排除 smoke.js，app.js 里不再残留场景实现', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(
    pkg.build.files.includes('!src/renderer/smoke.js'),
    'build.files 必须显式排除 smoke.js，否则 src/** 会把它打进 asar'
  );

  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(!app.includes('runSmokeScenario'), 'app.js 只该负责按需加载，不该再带场景实现');
  assert.ok(!app.includes('scenario === \'chat\''), 'app.js 里不该残留任何场景分支');
  assert.ok(app.includes("script.src = 'smoke.js'"), 'app.js 必须按需注入 smoke.js');
});
