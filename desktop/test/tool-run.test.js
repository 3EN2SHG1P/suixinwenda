/**
 * 文件：desktop/test/tool-run.test.js
 * 职责：工具命令拼接、子进程环境注入、stdout 结果解析。
 *
 * 这三条错了都不会报错，只会「备份/恢复到另一个库」，所以必须有单测压住。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { toolCommand, toolEnv, parseLastJson } = require('../src/tool-run.js');

test('toolCommand 开发态走 uv run python -m tools.<name>，cwd 是 backend', () => {
  const command = toolCommand({
    packaged: false,
    resourcesPath: '',
    backendDir: 'C:\\app\\backend',
    name: 'backup',
    args: ['--out', 'C:\\out\\a.zip']
  });
  assert.strictEqual(command.cmd, 'uv');
  assert.deepStrictEqual(command.args, [
    'run',
    'python',
    '-m',
    'tools.backup',
    '--out',
    'C:\\out\\a.zip'
  ]);
  assert.strictEqual(command.cwd, 'C:\\app\\backend');
});

test('toolCommand 打包态走 exe 子命令，cwd 是 exe 所在目录', () => {
  const command = toolCommand({
    packaged: true,
    resourcesPath: 'D:\\app\\resources',
    backendDir: 'C:\\app\\backend',
    name: 'restore',
    args: ['--from', 'x.zip', '--force']
  });
  const exeDir = path.dirname(path.join('D:\\app\\resources', 'backend', 'suixinwenda-backend.exe'));
  assert.strictEqual(command.cmd, path.join('D:\\app\\resources', 'backend', 'suixinwenda-backend.exe'));
  assert.deepStrictEqual(command.args, ['restore', '--from', 'x.zip', '--force']);
  assert.strictEqual(command.cwd, exeDir);
});

test('toolCommand 五个工具名都走同一个规则，未知名字直接抛', () => {
  ['backup', 'export', 'purge', 'restore', 'storage_test'].forEach((name) => {
    const command = toolCommand({ packaged: false, backendDir: '/b', name, args: [] });
    assert.strictEqual(command.args[3], `tools.${name}`);
  });
  assert.throws(() => toolCommand({ packaged: false, backendDir: '/b', name: 'drop', args: [] }), /不支持的工具/);
});

test('toolEnv 注入 env 文件，并剔除外层 shell 的库相关变量', () => {
  const env = toolEnv(
    {
      PATH: 'x',
      DATA_DIR: 'outer',
      DB_HOST: '10.0.0.9',
      DB_BACKEND: 'mysql',
      DB_PASSWORD: 'leaked',
      BACKEND_HOST: '0.0.0.0'
    },
    { envFile: 'C:\\userData\\config.env', dataDir: '' }
  );
  assert.strictEqual(env.SUIXINWENDA_ENV_FILE, 'C:\\userData\\config.env');
  assert.strictEqual(env.PATH, 'x', '父进程环境必须保留');
  // load_env() 是「已存在不覆盖」：外层 shell 的同名变量会压住配置文件，
  // 结果是「界面显示切换成功，备份/恢复操作的是另一个库」，而且全程没有报错
  ['DATA_DIR', 'DB_HOST', 'DB_BACKEND', 'DB_PASSWORD', 'BACKEND_HOST'].forEach((key) => {
    assert.strictEqual(key in env, false, `${key} 必须从工具子进程的环境里剔除`);
  });
  assert.strictEqual('DATA_DIR' in toolEnv({}, { envFile: 'a', dataDir: '' }), false);
});

test('toolEnv 剔除后仍能注入解密口令与 dataDir', () => {
  const env = toolEnv(
    { DB_PASSWORD: 'leaked' },
    { envFile: 'a', dataDir: 'C:\\data', dbPassword: 'real' }
  );
  assert.strictEqual(env.DB_PASSWORD, 'real', '注入必须发生在剔除之后');
  assert.strictEqual(env.DATA_DIR, 'C:\\data');
});

test('toolEnv 强制 Python 子进程用 UTF-8 输出', () => {
  // 中文 Windows 上不设这两个变量，Python 按 cp936 编码 stdout，Node 按 UTF-8 解码就是乱码
  const env = toolEnv({}, {});
  assert.strictEqual(env.PYTHONUTF8, '1');
  assert.strictEqual(env.PYTHONIOENCODING, 'utf-8');
  const inherited = toolEnv({ PYTHONUTF8: '0' }, {});
  assert.strictEqual(inherited.PYTHONUTF8, '1', '父进程已设成 0 也要纠正过来');
});

test('toolEnv 非空 dataDir 才写 DATA_DIR', () => {
  const env = toolEnv({}, { envFile: 'C:\\userData\\config.env', dataDir: 'C:\\userData\\data' });
  assert.strictEqual(env.DATA_DIR, 'C:\\userData\\data');
});

test('parseLastJson 取最后一行 JSON，忽略无关前缀行与空行', () => {
  assert.deepStrictEqual(parseLastJson('{"ok":true,"files":3}'), { ok: true, files: 3 });
  assert.deepStrictEqual(
    parseLastJson('Resolved 12 packages\n{"ok":true}\n\n'),
    { ok: true },
    '带无关前缀行也要能解析'
  );
  assert.deepStrictEqual(parseLastJson('{"ok":false}\n{"ok":true}'), { ok: true }, '多行 JSON 取最后一条');
  assert.strictEqual(parseLastJson(''), null);
  assert.strictEqual(parseLastJson('   \n  '), null);
  assert.strictEqual(parseLastJson('备份完成，但没有输出 JSON'), null);
  assert.strictEqual(parseLastJson('{ 这不是 JSON }'), null);
});
