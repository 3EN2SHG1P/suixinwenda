/**
 * 文件：desktop/test/artifacts.test.js
 * 职责：产物列举与删除的路径校验——删除不可逆，越界必须一律拒绝。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listArtifacts,
  listArtifactsAsync,
  resolveArtifact,
  deleteArtifact,
  revealMode
} = require('../src/artifacts.js');

const created = [];

function makeRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-artifact-'));
  created.push(base);
  const backupDir = path.join(base, 'backups');
  const exportDir = path.join(base, 'exports');
  fs.mkdirSync(backupDir);
  fs.mkdirSync(exportDir);
  fs.writeFileSync(path.join(backupDir, 'a.zip'), 'x'.repeat(100));
  fs.mkdirSync(path.join(exportDir, 'dump-1'));
  fs.writeFileSync(path.join(exportDir, 'dump-1', 'users.jsonl'), 'y'.repeat(50));
  return [
    { kind: 'backup', dir: backupDir },
    { kind: 'export', dir: exportDir }
  ];
}

test.after(() => {
  created.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

test('listArtifacts 列出文件与目录，并按时间倒序', () => {
  const roots = makeRoots();
  const items = listArtifacts(roots);
  assert.strictEqual(items.length, 2);
  const backup = items.find((item) => item.kind === 'backup');
  assert.strictEqual(backup.name, 'a.zip');
  assert.strictEqual(backup.size, 100);
  const dump = items.find((item) => item.kind === 'export');
  assert.strictEqual(dump.isDir, true);
  assert.strictEqual(dump.size, 50, '目录体积要递归统计');
  assert.ok(items[0].createdAt >= items[1].createdAt);
});

test('listArtifacts 忽略不存在的根目录', () => {
  const roots = makeRoots();
  roots.push({ kind: 'auto-backup', dir: path.join(os.tmpdir(), 'sxw-artifact-missing-xyz') });
  assert.strictEqual(listArtifacts(roots).length, 2);
});

test('listArtifactsAsync 与同步版结果一致（主进程走异步，别让 UI 卡住）', async () => {
  const roots = makeRoots();
  const syncItems = listArtifacts(roots);
  const asyncItems = await listArtifactsAsync(roots);
  assert.deepStrictEqual(
    asyncItems.map((item) => [item.id, item.name, item.size, item.createdAt]),
    syncItems.map((item) => [item.id, item.name, item.size, item.createdAt])
  );
});

test('resolveArtifact 拒绝所有越界形态', () => {
  const roots = makeRoots();
  const bad = [
    'backup/../a.zip',
    'backup/../../windows/system32',
    'backup/a/b.zip',
    'backup/a\\b.zip',
    'backup/',
    'backup',
    '../backup/a.zip',
    'unknown/a.zip',
    'backup/C:\\Windows\\notepad.exe',
    ''
  ];
  bad.forEach((id) => {
    assert.strictEqual(resolveArtifact(roots, id), null, `应拒绝：${id}`);
  });
});

test('resolveArtifact 正常 id 解析到根目录下的直接子项', () => {
  const roots = makeRoots();
  const found = resolveArtifact(roots, 'backup/a.zip');
  assert.ok(found);
  assert.strictEqual(path.dirname(found.path), path.resolve(roots[0].dir));
});

test('revealMode 区分「进入目录」与「定位文件」', () => {
  const roots = makeRoots();
  const file = path.join(roots[0].dir, 'a.zip');
  const dir = path.join(roots[1].dir, 'dump-1');
  assert.strictEqual(revealMode(dir), 'open', '导出是目录，应该走进去');
  assert.strictEqual(revealMode(file), 'locate', '备份是文件，应该定位到它');
  assert.strictEqual(revealMode(path.join(roots[0].dir, 'nope.zip')), null);
});

test('deleteArtifact 能删文件与目录，越界目标不动', () => {
  const roots = makeRoots();
  assert.deepStrictEqual(deleteArtifact(roots, 'backup/a.zip'), { ok: true, id: 'backup/a.zip' });
  assert.strictEqual(fs.existsSync(path.join(roots[0].dir, 'a.zip')), false);

  assert.deepStrictEqual(deleteArtifact(roots, 'export/dump-1'), { ok: true, id: 'export/dump-1' });
  assert.strictEqual(fs.existsSync(path.join(roots[1].dir, 'dump-1')), false);

  const rejected = deleteArtifact(roots, 'backup/../exports');
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(fs.existsSync(roots[1].dir), true, '越界删除必须被拒绝');
});
