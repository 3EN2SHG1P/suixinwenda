/**
 * 文件：desktop/test/main-log.test.js
 * 职责：主进程文件日志的三条硬要求——本地时间戳、超限轮转、冒烟不落盘。
 *
 * 这几条错了都不会当场报错，只会「用户报问题时日志里啥也没有」，所以必须有单测压住。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogFile } = require('../src/main-log.js');

const created = [];

function makeDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-mainlog-'));
  created.push(base);
  return base;
}

// 固定时间：断言里要逐字比对 YYYY-MM-DD HH:mm:ss，不能跟着真实时钟走
const FIXED_NOW = () => new Date(2026, 10, 4, 9, 5, 7).getTime();

function logFileAt(base, options = {}) {
  return createLogFile({
    app: { getPath: () => base },
    isSmoke: false,
    now: FIXED_NOW,
    ...options
  });
}

test.after(() => {
  created.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

test('写入两行后文件里是级别 + 本地时间格式', () => {
  const base = makeDir();
  const logFile = logFileAt(base);
  logFile.log('info', '小窗已显示');
  logFile.log('error', '后端没起来');
  const text = fs.readFileSync(path.join(base, 'logs', 'main.log'), 'utf8');
  assert.match(text, /^2026-11-04 09:05:07 \[info\] 小窗已显示$/m);
  assert.match(text, /^2026-11-04 09:05:07 \[error\] 后端没起来$/m);
});

test('多行文本压成一行并截断到 500 字符', () => {
  const base = makeDir();
  const logFile = logFileAt(base);
  logFile.log('error', `第一行\r\n第二行${'x'.repeat(600)}`);
  const text = fs.readFileSync(path.join(base, 'logs', 'main.log'), 'utf8').trimEnd();
  assert.strictEqual(text.split('\n').length, 1, '一条日志只占一行');
  assert.ok(text.endsWith('x'.repeat(10)));
  assert.strictEqual(text.length, '2026-11-04 09:05:07 [error] '.length + 500);
});

test('超过 maxBytes 时轮转出 main.log.1，只留一份历史', () => {
  const base = makeDir();
  const logFile = logFileAt(base, { maxBytes: 60 });
  logFile.log('info', 'A'.repeat(80));
  logFile.log('info', '第二行');
  logFile.log('info', '第三行');
  const dir = path.join(base, 'logs');
  assert.ok(fs.existsSync(path.join(dir, 'main.log.1')), '应当轮转出 main.log.1');
  assert.strictEqual(fs.existsSync(path.join(dir, 'main.log.2')), false, '只留一份历史');
  assert.match(fs.readFileSync(path.join(dir, 'main.log.1'), 'utf8'), /第二行/);
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'), /第三行/);
});

test('isSmoke 为真时既不建目录也不写文件', () => {
  const base = makeDir();
  const logFile = logFileAt(base, { isSmoke: true });
  logFile.log('info', '不该落盘');
  assert.strictEqual(fs.existsSync(path.join(base, 'logs')), false);
});

test('路径写不了时不抛异常（日志不许影响启动）', () => {
  const base = makeDir();
  // 把 userData 换成一个文件：mkdir 与 append 都会失败，模拟目录被占 / 无权限
  const blocked = path.join(base, 'blocked');
  fs.writeFileSync(blocked, 'x');
  const logFile = createLogFile({ app: { getPath: () => blocked }, isSmoke: false });
  assert.doesNotThrow(() => logFile.log('error', '仍然不抛'));
});
