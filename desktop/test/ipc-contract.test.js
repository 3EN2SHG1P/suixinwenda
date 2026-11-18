/**
 * 文件：desktop/test/ipc-contract.test.js
 * 职责：断言主进程注册的 IPC 通道与 preload 调用的通道一一对应。
 *
 * 为什么需要：这是跨进程的**字符串契约**，任何单元测试都覆盖不到。
 * 把 `chat:send` 改名成 `chat:stream` 却漏改 preload 时，两侧代码各自"看起来都对"，
 * 187 个用例全绿、5 个 CI job 全绿，只有用户点下那个按钮才会发现「毫无反应」，
 * 控制台才出现 No handler registered for 'chat:stream'。
 *
 * 扫描范围为什么是 src 全量、而不只是 main.js：
 * app-window:* 那 14 个通道注册在 app-windows.js 里，只扫 main.js 会把它们全判成缺口。
 * 这条经验是实测踩出来的，别改成只读 main.js。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

/** 递归收集 src 下的 .js，排除 renderer（那是页面代码，不注册 IPC）。 */
function mainProcessFiles(dir = SRC) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'renderer') {
        continue;
      }
      files.push(...mainProcessFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

/** 主进程侧注册：ipcMain.handle('x') / ipcMain.on('x')。只认字符串字面量，实测全部如此。 */
function registeredChannels() {
  const found = new Map();
  for (const file of mainProcessFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const pattern = /ipcMain\.(?:handle|on)\(\s*['"]([\w:.-]+)['"]/g;
    for (const match of text.matchAll(pattern)) {
      found.set(match[1], path.relative(SRC, file));
    }
  }
  return found;
}

/** preload 侧调用：xxx.invoke('x') / xxx.send('x')。 */
function calledChannels() {
  const found = new Map();
  for (const file of mainProcessFiles()) {
    if (!path.basename(file).includes('preload')) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const pattern = /(?:invoke|send)\(\s*['"]([\w:.-]+)['"]/g;
    for (const match of text.matchAll(pattern)) {
      found.set(match[1], path.basename(file));
    }
  }
  return found;
}

test('扫描本身有效：通道数量不为零', () => {
  // 正则失效（例如以后改用常量拼通道名）时，下面的「相等」断言会因两边都是 0 条而假通过
  const registered = registeredChannels();
  const called = calledChannels();
  assert.ok(registered.size > 0, '没有扫到任何 ipcMain 注册点，正则可能已失效');
  assert.ok(called.size > 0, '没有扫到任何 preload 调用点，正则可能已失效');
});

test('preload 调用的每个通道都有主进程注册', () => {
  const registered = registeredChannels();
  const missing = [];
  for (const [channel, file] of calledChannels()) {
    if (!registered.has(channel)) {
      missing.push(`${channel}（${file} 调用，但没有 ipcMain.handle/on 注册）`);
    }
  }
  assert.deepStrictEqual(missing, [], `以下通道调用时会抛 No handler registered：\n${missing.join('\n')}`);
});

test('主进程注册的每个通道都被 preload 使用（没有死通道）', () => {
  const called = calledChannels();
  const orphan = [];
  for (const [channel, file] of registeredChannels()) {
    if (!called.has(channel)) {
      orphan.push(`${channel}（${file} 注册，但 preload 从未调用）`);
    }
  }
  // 若将来出现「主进程单向推送」的通道（不需要 preload 调用），
  // 在这里加白名单并写明原因，不要直接删掉这条断言
  assert.deepStrictEqual(orphan, [], `以下通道注册后无人调用，确认是有意保留还是改名漏改：\n${orphan.join('\n')}`);
});
