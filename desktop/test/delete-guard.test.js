/**
 * 文件：desktop/test/delete-guard.test.js
 * 职责：产物删除闸门——重点覆盖「记录被写脏后一次递归删除清空用户目录」的场景。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkDeleteTarget } = require('../src/delete-guard');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-delete-guard-'));
}

test('正常产物目录允许删除', () => {
  const root = sandbox();
  const target = path.join(root, 'suixinwenda-20260101-120000');
  fs.mkdirSync(target);

  const verdict = checkDeleteTarget(target, { fs, path, protectedPaths: [] });

  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.missing, false);
  assert.strictEqual(verdict.path, path.resolve(target));
});

test('目标已经不存在：允许（删除记录本身合法，rmSync 是空操作）', () => {
  const root = sandbox();
  const verdict = checkDeleteTarget(path.join(root, 'gone'), { fs, path, protectedPaths: [] });

  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.missing, true);
});

test('磁盘根目录一律拒绝', () => {
  const root = path.parse(process.cwd()).root;
  const verdict = checkDeleteTarget(root, { fs, path, protectedPaths: [] });

  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.error, /根目录/);
});

test('受保护目录拒绝（用户主目录 / 应用数据目录）', () => {
  const root = sandbox();
  const verdict = checkDeleteTarget(root, { fs, path, protectedPaths: [root] });

  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.error, /受保护/);
});

test('符号链接拒绝：即使记录里写的是链接路径', () => {
  const fakeFs = {
    lstatSync() {
      return { isSymbolicLink: () => true };
    }
  };

  const verdict = checkDeleteTarget(path.join(sandbox(), 'link'), {
    fs: fakeFs,
    path,
    protectedPaths: []
  });

  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.error, /符号链接/);
});

test('检查本身失败时按拒绝处理，绝不放行', () => {
  const fakeFs = {
    lstatSync() {
      const error = new Error('EACCES');
      error.code = 'EACCES';
      throw error;
    }
  };

  const verdict = checkDeleteTarget(path.join(sandbox(), 'x'), {
    fs: fakeFs,
    path,
    protectedPaths: []
  });

  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.error, /EACCES/);
});

test('受保护判定与大小写无关（Windows 路径不区分大小写）', () => {
  const root = sandbox();
  const verdict = checkDeleteTarget(root, {
    fs,
    path,
    protectedPaths: [root.toUpperCase()]
  });

  assert.strictEqual(verdict.ok, false);
});
