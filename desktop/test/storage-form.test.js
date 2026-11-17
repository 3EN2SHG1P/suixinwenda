/**
 * 文件：desktop/test/storage-form.test.js
 * 职责：存储切换表单的校验规则——本机/远程判定、远程放行、CA 证书、切回 SQLite 的清理。
 *
 * 为什么单独测：这些规则是「页面能不能把配置写歪」的最后一道闸。判错的两种结果都不会报错：
 * 远程地址没拦住 → 后端拒绝启动，用户只看到「进程已退出」；放行标记没清 → 安全提示形同虚设。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  DB_LOCAL_HOSTS,
  STORAGE_KEYS,
  sanitizeStorageForm,
  sanitizeRestartPatch,
  probeEnv
} = require('../src/storage-form.js');

const OK = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'root',
  DB_PASSWORD: 'pw',
  DB_NAME: 'suixinwenda'
};

const noCert = { existsSync: () => false };
const anyCert = { existsSync: () => true };

test('白名单只认存储相关的键：backend 之类的键会被丢掉', () => {
  assert.deepStrictEqual(STORAGE_KEYS, [
    'DB_BACKEND',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'DB_ALLOW_REMOTE',
    'DB_SSL_CA'
  ]);
  const clean = sanitizeStorageForm({ ...OK, JWT_SECRET: 'leak' }, anyCert);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(clean.values, 'JWT_SECRET'), false);
});

test('本机地址不要求勾选，且把放行标记写成空', () => {
  DB_LOCAL_HOSTS.forEach((host) => {
    const clean = sanitizeStorageForm({ ...OK, DB_HOST: host, DB_ALLOW_REMOTE: '1' }, anyCert);
    assert.strictEqual(clean.error, undefined, host);
    assert.strictEqual(clean.values.DB_ALLOW_REMOTE, '', `${host} 是本机，不该留下放行标记`);
  });
});

test('远程地址没勾选 → 当场拦住，而不是等后端退出', () => {
  const clean = sanitizeStorageForm({ ...OK, DB_HOST: '10.0.0.9' }, anyCert);
  assert.match(clean.error, /远程/);
});

test('远程地址勾选后放行，且只认 1', () => {
  const ok = sanitizeStorageForm({ ...OK, DB_HOST: 'db.example.com', DB_ALLOW_REMOTE: '1' }, anyCert);
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(ok.values.DB_ALLOW_REMOTE, '1');

  const truthy = sanitizeStorageForm({ ...OK, DB_HOST: 'db.example.com', DB_ALLOW_REMOTE: 'true' }, anyCert);
  assert.match(truthy.error, /远程/, 'true 不算同意，只有 1 才算');
});

test('CA 证书：可空；填了必须存在且不能带换行', () => {
  assert.strictEqual(sanitizeStorageForm(OK, anyCert).values.DB_SSL_CA, '');
  assert.match(sanitizeStorageForm({ ...OK, DB_SSL_CA: 'C:\\certs\\ca.pem' }, noCert).error, /证书文件不存在/);
  assert.match(sanitizeStorageForm({ ...OK, DB_SSL_CA: 'a\nb' }, anyCert).error, /不合法/);

  const kept = sanitizeStorageForm({ ...OK, DB_SSL_CA: 'C:\\certs\\ca.pem' }, anyCert);
  assert.strictEqual(kept.values.DB_SSL_CA, 'C:\\certs\\ca.pem', 'TLS 配置不能被静默丢掉');
});

test('切回 SQLite 时清掉放行标记与 CA：安全开关只对当前这套 MySQL 有意义', () => {
  const clean = sanitizeRestartPatch({ DB_BACKEND: 'sqlite' }, anyCert);
  assert.deepStrictEqual(clean.patch, { DB_BACKEND: 'sqlite', DB_ALLOW_REMOTE: '', DB_SSL_CA: '' });
});

test('切到 MySQL 必须带齐连接参数，非法存储类型直接拒', () => {
  assert.match(sanitizeRestartPatch({ DB_BACKEND: 'postgres' }, anyCert).error, /不支持的存储类型/);
  const clean = sanitizeRestartPatch({ DB_BACKEND: 'mysql', ...OK }, anyCert);
  assert.strictEqual(clean.patch.DB_BACKEND, 'mysql');
  assert.strictEqual(clean.patch.DB_PASSWORD, 'pw');
  assert.strictEqual(clean.patch.DB_ALLOW_REMOTE, '');
});

test('probeEnv 带齐六个探测参数（含 CA）', () => {
  assert.deepStrictEqual(probeEnv(OK), {
    SUIXINWENDA_PROBE_HOST: '127.0.0.1',
    SUIXINWENDA_PROBE_PORT: '3306',
    SUIXINWENDA_PROBE_USER: 'root',
    SUIXINWENDA_PROBE_PASSWORD: 'pw',
    SUIXINWENDA_PROBE_NAME: 'suixinwenda',
    SUIXINWENDA_PROBE_SSL_CA: ''
  });
});
