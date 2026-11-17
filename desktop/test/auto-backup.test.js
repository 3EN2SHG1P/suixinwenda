/**
 * 文件：desktop/test/auto-backup.test.js
 * 职责：定期自动备份的三个判定分支——超期触发、未超期跳过、开关关闭跳过。
 *
 * 为什么值得单测：这段逻辑判错的两种表现都不会报错，只会「天天多一个几十 MB 的包」
 * 或「永远不备份」，用户直到真需要回滚时才会发现。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_DAYS,
  MAX_DAYS,
  DAY_MS,
  normalizeDays,
  settingsOf,
  latestBackupTime,
  shouldAutoBackup
} = require('../src/auto-backup.js');

const created = [];
test.after(() => {
  created.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  created.length = 0;
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-autobak-'));
  created.push(dir);
  return dir;
}

test('normalizeDays 把非法与越界值收敛到合法范围', () => {
  assert.strictEqual(normalizeDays(undefined), DEFAULT_DAYS);
  assert.strictEqual(normalizeDays('abc'), DEFAULT_DAYS);
  assert.strictEqual(normalizeDays(0), DEFAULT_DAYS);
  assert.strictEqual(normalizeDays(-3), DEFAULT_DAYS);
  assert.strictEqual(normalizeDays(3), 3);
  assert.strictEqual(normalizeDays('14'), 14);
  assert.strictEqual(normalizeDays(9999), MAX_DAYS);
});

test('settingsOf：没配过 = 开 + 7 天；显式关掉才算关', () => {
  assert.deepStrictEqual(settingsOf(undefined), { enabled: true, days: DEFAULT_DAYS });
  assert.deepStrictEqual(settingsOf({}), { enabled: true, days: DEFAULT_DAYS });
  assert.deepStrictEqual(settingsOf({ autoBackupEnabled: false, autoBackupDays: 30 }), {
    enabled: false,
    days: 30
  });
});

test('latestBackupTime 取多个目录里最新的 zip，忽略目录与非 zip', () => {
  const first = tempDir();
  const second = tempDir();
  const oldFile = path.join(first, 'before-upgrade-sqlite-1.zip');
  const newFile = path.join(second, 'before-auto-sqlite-2.zip');
  fs.writeFileSync(oldFile, 'a');
  fs.writeFileSync(newFile, 'b');
  fs.writeFileSync(path.join(second, 'notes.txt'), 'c');
  fs.mkdirSync(path.join(second, 'weird.zip'));

  const now = Date.now();
  fs.utimesSync(oldFile, new Date(now - 10 * DAY_MS), new Date(now - 10 * DAY_MS));
  fs.utimesSync(newFile, new Date(now - 2 * DAY_MS), new Date(now - 2 * DAY_MS));

  const latest = latestBackupTime([first, second, path.join(first, 'missing')], { fs });
  assert.strictEqual(Math.round(latest), Math.round(fs.statSync(newFile).mtimeMs));
});

test('latestBackupTime 目录不存在时返回 0，不抛错', () => {
  assert.strictEqual(latestBackupTime([path.join(tempDir(), 'nope')], { fs }), 0);
});

test('shouldAutoBackup：超期触发 / 未超期跳过 / 关闭跳过 / 一份都没有时触发', () => {
  const now = Date.now();
  assert.strictEqual(
    shouldAutoBackup({ enabled: true, days: 7, lastAt: now - 8 * DAY_MS, now }),
    true,
    '超过 7 天必须备份'
  );
  assert.strictEqual(
    shouldAutoBackup({ enabled: true, days: 7, lastAt: now - 6 * DAY_MS, now }),
    false,
    '没超过 7 天不该重复备份'
  );
  assert.strictEqual(
    shouldAutoBackup({ enabled: false, days: 7, lastAt: now - 100 * DAY_MS, now }),
    false,
    '开关关掉就一律不跑'
  );
  assert.strictEqual(
    shouldAutoBackup({ enabled: true, days: 7, lastAt: 0, now }),
    true,
    '一份备份都没有时最该备份（不能因为「差值为负」永远等下去）'
  );
});
