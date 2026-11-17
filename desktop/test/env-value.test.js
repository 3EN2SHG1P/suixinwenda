/**
 * 文件：desktop/test/env-value.test.js
 * 职责：config.env 解析的唯一实现——重点是「密码里的 # 不能被当成注释」。
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { parseEnvValue } = require('../src/env-value');

test('取普通值并忽略空行与整行注释', () => {
  const text = ['# DB_HOST=wrong', '', 'DB_HOST=127.0.0.1', 'DB_PORT=3306'].join('\r\n');
  assert.strictEqual(parseEnvValue(text, 'DB_HOST'), '127.0.0.1');
  assert.strictEqual(parseEnvValue(text, 'DB_PORT'), '3306');
  assert.strictEqual(parseEnvValue(text, 'DB_USER'), '');
});

test('密码里的 # 原样保留（旧实现会截成 p@ss）', () => {
  const text = 'DB_PASSWORD=p@ss#1\n';
  assert.strictEqual(parseEnvValue(text, 'DB_PASSWORD'), 'p@ss#1');
});

test('空白之后的 # 才是行内注释', () => {
  const text = 'DB_PASSWORD=secret # 这是说明\n';
  assert.strictEqual(parseEnvValue(text, 'DB_PASSWORD'), 'secret');
});

test('引号包裹的值整段保留，不剥注释也不去引号内的 #', () => {
  const text = 'DB_PASSWORD="p@ss #1"\n';
  assert.strictEqual(parseEnvValue(text, 'DB_PASSWORD'), 'p@ss #1');
});

test('键名必须完全匹配，不能把 DB_PASSWORD_ENC 当成 DB_PASSWORD', () => {
  const text = 'DB_PASSWORD_ENC=abc\nDB_PASSWORD=plain\n';
  assert.strictEqual(parseEnvValue(text, 'DB_PASSWORD'), 'plain');
});

test('含 = 的值从第一个等号之后整段取', () => {
  const text = 'DB_PASSWORD=a=b=c\n';
  assert.strictEqual(parseEnvValue(text, 'DB_PASSWORD'), 'a=b=c');
});
