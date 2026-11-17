/**
 * 文件：desktop/test/db-secret.test.js
 * 职责：数据库密码的存法——密文写入、明文迁移、解密失败回落。
 *
 * 这里守的是「配置文件里 grep 不到明文密码」，以及「迁移之后后端仍拿得到密码」。
 */
const test = require('node:test');
const assert = require('node:assert');

const { readSecret, writeSecret, dropKey, upsertKey, readValue, ENC_KEY, PLAIN_KEY } = require('../src/db-secret.js');

// 可逆假加密：真实实现是 Electron safeStorage（DPAPI），测试里只关心「写进去的是密文」
const fakeEncrypt = (text) => `enc:${Buffer.from(text, 'utf8').toString('base64')}`;
const fakeDecrypt = (token) => {
  if (!token.startsWith('enc:')) {
    throw new Error('bad token');
  }
  return Buffer.from(token.slice(4), 'base64').toString('utf8');
};

test('readValue 跳过注释、去引号', () => {
  const text = '# DB_PASSWORD=commented\nDB_PASSWORD="real"  \nDB_PASSWORD_ENC=tok\n';
  assert.strictEqual(readValue(text, PLAIN_KEY), 'real');
  assert.strictEqual(readValue(text, ENC_KEY), 'tok');
  assert.strictEqual(readValue(text, 'DB_USER'), '');
});

test('writeSecret 只写密文并删掉明文行', () => {
  const before = 'JWT_SECRET=abc\nDB_PASSWORD=123456\n';
  const after = writeSecret(before, '123456', fakeEncrypt);

  assert.match(after, /^JWT_SECRET=abc$/m, '其它行必须原样保留');
  assert.ok(!new RegExp(`^${PLAIN_KEY}=`, 'm').test(after), '明文行必须被删掉');
  assert.match(after, new RegExp(`^${ENC_KEY}=enc:`, 'm'), '必须写入密文');
  assert.ok(!after.includes('123456'), '整个文件里不能出现明文密码');
});

test('readSecret 解密密文，并指出明文是否需要迁移', () => {
  const encrypted = writeSecret('', 'p@ss', fakeEncrypt);
  assert.deepStrictEqual(readSecret(encrypted, fakeDecrypt), { password: 'p@ss', needsMigration: false });

  const legacy = `${PLAIN_KEY}=legacy-pw\n`;
  assert.deepStrictEqual(readSecret(legacy, fakeDecrypt), {
    password: 'legacy-pw',
    needsMigration: true
  });
  assert.deepStrictEqual(readSecret('', fakeDecrypt), { password: '', needsMigration: false });
});

test('解不开密文时回落到明文，不让应用直接起不来', () => {
  const text = `${ENC_KEY}=broken\n${PLAIN_KEY}=fallback-pw\n`;
  const result = readSecret(text, () => {
    throw new Error('DPAPI 解不开');
  });
  assert.strictEqual(result.password, 'fallback-pw');
});

test('没有可用加密时退回明文（与 auth.bin 的降级口径一致）', () => {
  const after = writeSecret('', 'pw', () => '');
  assert.match(after, new RegExp(`^${PLAIN_KEY}=pw$`, 'm'));
  assert.ok(!after.includes(ENC_KEY));
});

test('dropKey 不动注释模板、不误删相邻键', () => {
  const text = '# DB_PASSWORD=模板\nDB_PASSWORD=real\nDB_PASSWORD_ENC=tok\n';
  const after = dropKey(text, PLAIN_KEY);
  assert.match(after, /^# DB_PASSWORD=模板$/m);
  assert.ok(!/^DB_PASSWORD=real$/m.test(after));
  assert.match(after, /^DB_PASSWORD_ENC=tok$/m);
});

test('upsertKey 替换已有键、追加缺失键', () => {
  assert.match(upsertKey(`${ENC_KEY}=old\n`, ENC_KEY, 'new'), new RegExp(`^${ENC_KEY}=new$`, 'm'));
  assert.match(upsertKey('A=1\n', 'B', '2'), /^B=2$/m);
});
