/**
 * 文件：desktop/test/runtime-cleanup.test.js
 * 职责：运行时模型文件（明文 API Key）的落盘与清理语义——写得出、删得掉、启动清理可复用。
 * 跑法：`cd desktop; npm test`
 *
 * 为什么单独成文件：这是「崩溃后明文 Key 残留在磁盘」的唯一回归点。
 * 退出路径（beginShutdown / hardExit / will-quit）需要 electron，测不了；
 * 但「applyModels 写文件 / removeRuntimeModels 连目录删掉」这层纯 Node 逻辑可以压死。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBackendManager } = require('../src/backend-manager.js');

const createdDirs = [];

test.after(() => {
  createdDirs.forEach((dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  createdDirs.length = 0;
});

function tempUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-userdata-'));
  createdDirs.push(dir);
  return dir;
}

function makeManager(userData) {
  return createBackendManager({
    app: { isPackaged: true, getPath: (name) => (name === 'userData' ? userData : '') },
    backendDir: userData,
    spawn: () => {
      throw new Error('本用例不启动后端');
    },
    execFile: () => {}
  });
}

test('applyModels 把明文配置写到 userData/runtime/models.json', () => {
  const userData = tempUserData();
  const manager = makeManager(userData);
  const payload = { default: 'm-1', models: [{ id: 'm-1', apiKey: 'plain-key-for-test' }] };

  const result = manager.applyModels(payload);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.models, 1);
  assert.strictEqual(result.path, manager.runtimeModelsPath());
  const text = fs.readFileSync(result.path, 'utf8');
  assert.match(text, /plain-key-for-test/);
  assert.strictEqual(path.dirname(result.path), path.join(userData, 'runtime'));
});

test('removeRuntimeModels 连 runtime 目录一起删掉（启动清理与退出清理共用）', () => {
  const userData = tempUserData();
  const manager = makeManager(userData);
  const { path: file } = manager.applyModels({ default: 'm-1', models: [{ id: 'm-1' }] });
  const runtimeDir = path.dirname(file);
  assert.strictEqual(fs.existsSync(runtimeDir), true);

  manager.removeRuntimeModels();

  assert.strictEqual(fs.existsSync(runtimeDir), false);
  // 重复调用必须安全：启动清理与退出清理可能连着跑
  assert.doesNotThrow(() => manager.removeRuntimeModels());
});

test('removeRuntimeModels 在目录本就不存在时不抛异常（首次启动）', () => {
  const userData = tempUserData();
  const manager = makeManager(userData);
  assert.doesNotThrow(() => manager.removeRuntimeModels());
});
