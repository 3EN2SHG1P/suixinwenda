/**
 * 文件：desktop/test/path-guard.test.js
 * 职责：路径白名单与附件类型白名单的负面用例——这两条是「渲染进程被注入」时的最后一道闸。
 * 跑法：`cd desktop; npm test`
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  OPENABLE_EXTS,
  isInside,
  isRevealAllowed,
  isOpenableAttachment
} = require('../src/path-guard.js');

// 用 resolve 而不是写死盘符：Windows 上 `/tmp/x` 会被解析成「当前盘符:\tmp\x」，
// 大小写与分隔符都由平台决定，测试因此不需要平台分支
const ROOT = path.resolve('/tmp/sxw-root');

test('isInside：目录本身与任意深度的子项都算在内', () => {
  assert.strictEqual(isInside(ROOT, ROOT), true);
  assert.strictEqual(isInside(ROOT, path.join(ROOT, 'a.zip')), true);
  assert.strictEqual(isInside(ROOT, path.join(ROOT, 'sub', 'deep', 'b.zip')), true);
});

test('isInside：同前缀的兄弟目录不算在内（白名单绕过最常见的写法）', () => {
  assert.strictEqual(isInside(ROOT, `${ROOT}-evil`), false);
  assert.strictEqual(isInside(ROOT, path.join(`${ROOT}-evil`, 'a.zip')), false);
});

test('isInside：.. 穿越到白名单之外一律拒绝', () => {
  assert.strictEqual(isInside(ROOT, path.join(ROOT, '..', 'outside.zip')), false);
  assert.strictEqual(isInside(ROOT, path.join(ROOT, 'a', '..', '..', 'outside.zip')), false);
});

test('isInside：空值与非字符串不抛异常，且判为不在范围内', () => {
  assert.strictEqual(isInside('', ROOT), false);
  assert.strictEqual(isInside(ROOT, ''), false);
  assert.strictEqual(isInside(ROOT, null), false);
  assert.strictEqual(isInside(null, ROOT), false);
});

test('isRevealAllowed：产物根目录内的文件与记录里的具体路径都放行', () => {
  const record = path.resolve('/tmp/desktop-export/my-data');
  const allowed = [ROOT, record];
  assert.strictEqual(isRevealAllowed(path.join(ROOT, 'backup.zip'), allowed), true);
  assert.strictEqual(isRevealAllowed(record, allowed), true);
  assert.strictEqual(isRevealAllowed(path.join(record, 'users.jsonl'), allowed), true);
});

test('isRevealAllowed：白名单之外的任意绝对路径一律拒绝', () => {
  const allowed = [ROOT];
  assert.strictEqual(isRevealAllowed(path.resolve('/tmp/elsewhere/a.zip'), allowed), false);
  assert.strictEqual(isRevealAllowed('', allowed), false);
  assert.strictEqual(isRevealAllowed(path.join(ROOT, 'a.zip'), []), false);
  assert.strictEqual(isRevealAllowed(path.join(ROOT, 'a.zip'), null), false);
});

test('isOpenableAttachment：本应用支持的附件后缀全部放行', () => {
  const names = [
    'a.png',
    'a.JPG',
    'a.jpeg',
    'a.gif',
    'a.webp',
    'a.pdf',
    'a.docx',
    'a.xlsx',
    'a.xlsm',
    'a.md',
    'a.txt',
    'a.csv',
    'a.json'
  ];
  names.forEach((name) => assert.strictEqual(isOpenableAttachment(name), true, name));
});

test('isOpenableAttachment：可执行/脚本/快捷方式/无后缀/多点后缀一律拒绝', () => {
  const names = [
    'a.exe',
    'a.bat',
    'a.cmd',
    'a.ps1',
    'a.vbs',
    'a.js',
    'a.lnk',
    'a.url',
    'a.hta',
    'a.msi',
    'a.scr',
    'a.jar',
    'README',
    '.exe',
    'a.tar.gz'
  ];
  names.forEach((name) => assert.strictEqual(isOpenableAttachment(name), false, name));
});

test('OPENABLE_EXTS 不含任何可执行或脚本后缀', () => {
  ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.lnk', '.url', '.hta', '.msi'].forEach((ext) => {
    assert.strictEqual(OPENABLE_EXTS.has(ext), false, ext);
  });
});
