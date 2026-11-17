/**
 * 文件：desktop/src/tool-run.js
 * 职责：`backend/tools/*` 命令行工具的调用约定——命令拼接、子进程环境注入、stdout 结果解析。
 *
 * 为什么单独成模块：这三件事在备份 / 导出 / 清除 / 恢复 / 测试连接里各写一遍，
 * 而错一遍的后果都是「操作的不是当前那个库」。抽出来才能用 `node --test` 压住打包态与开发态两种拼法。
 *
 * 不 require('electron')：electron 的能力（是否打包、resourcesPath、env 文件位置）全部由调用方注入。
 */
const nodePath = require('node:path');

const { stripChildEnv } = require('./child-env');

/**
 * 工具名（= `backend/tools/<name>.py`，也 = 打包后 exe 的子命令名）。
 * migrate_uploads 平时由后端启动时自动跑，这里同样登记：手动触发时不应被「不支持的工具」挡住。
 * 增删工具名必须同步 backend/launcher.py 的 TOOLS（tests/test_launcher.py 会读这个文件的原文比对）。
 */
const TOOL_NAMES = [
  'backup',
  'export',
  'purge',
  'restore',
  'storage_test',
  'db_info',
  'migrate_uploads'
];

/**
 * 拼出「跑哪个工具」的命令。
 *
 * 打包态：`resources/backend/suixinwenda-backend.exe <name> ...args`，cwd 取 exe 所在目录——
 * 与 backend-manager 的 backendCommand() 同一约定（exe 旁的资源相对路径都按 cwd 解析）。
 * 开发态：`uv run python -m tools.<name> ...args`，cwd 必须是 backend/，否则导入不到 core。
 */
function toolCommand(options) {
  const opts = options || {};
  const name = String(opts.name || '');
  const args = Array.isArray(opts.args) ? opts.args.map((item) => String(item)) : [];
  if (!TOOL_NAMES.includes(name)) {
    throw new Error(`不支持的工具：${name}`);
  }
  if (opts.packaged) {
    const exe = nodePath.join(String(opts.resourcesPath || ''), 'backend', 'suixinwenda-backend.exe');
    return { cmd: exe, args: [name, ...args], cwd: nodePath.dirname(exe) };
  }
  return {
    cmd: 'uv',
    args: ['run', 'python', '-m', `tools.${name}`, ...args],
    cwd: String(opts.backendDir || '')
  };
}

/**
 * 工具子进程的环境变量。
 *
 * SUIXINWENDA_ENV_FILE 是必须的：打包态配置在 userData/config.env，
 * 少了它 core/config.py 会去 exe 旁边找 .env（不存在），静默回落到默认 SQLite——
 * 表现就是「备份/恢复操作的不是当前那个库」，而且全程不报错。
 *
 * dataDir 只在非空时注入：core/config.py 的 load_env() 是「已存在不覆盖」，
 * 开发态注进 backend/data 会压住用户 backend/.env 里的 DATA_DIR，
 * 制造出一个和上面完全对称的 bug。开发态调用方必须传空串。
 *
 * dbPassword 同理只在非空时注入：配置文件里存的是密文（DB_PASSWORD_ENC），
 * 后端与工具都只认明文，必须由主进程解密后经环境变量传进来。
 */
function toolEnv(baseEnv, options) {
  const opts = options || {};
  // 与后端子进程同一份黑名单：外层 shell 的 DB_* / DATA_DIR 不能盖过配置文件，
  // 否则备份/导出/清除/恢复会静默操作另一个库（恢复=往错库整库写入）
  const env = stripChildEnv(baseEnv);
  const envFile = String(opts.envFile || '');
  if (envFile) {
    env.SUIXINWENDA_ENV_FILE = envFile;
  }
  const dataDir = String(opts.dataDir || '');
  if (dataDir) {
    env.DATA_DIR = dataDir;
  }
  const dbPassword = String(opts.dbPassword || '');
  if (dbPassword) {
    // 放在最前面那批赋值里：外层 shell 里的同名变量不能盖过配置文件里的这份
    env.DB_PASSWORD = dbPassword;
  }
  // 工具的输出是「单行中文 JSON 到 stdout」：中文 Windows 上 Python 子进程默认按
  // console 代码页（cp936/GBK）编码，Node 按 UTF-8 解码就是一串「◆Û◆」乱码。
  // 强制 Python 侧也用 UTF-8，两边口径才一致（打包态的内置解释器同样认这两个变量）。
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

/**
 * 取 stdout 里最后一行能解析的 JSON。
 *
 * 工具约定是「单行 JSON 到 stdout」，但 `uv run` 会在前面插自己的提示行、
 * 后端的 logging 也可能落到 stdout；从后往前找第一行能解析的最稳，失败返回 null。
 */
function parseLastJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || (line[0] !== '{' && line[0] !== '[')) {
      continue;
    }
    try {
      return JSON.parse(line);
    } catch (error) {
      // 不是整行 JSON（日志、进度条），继续往前找
    }
  }
  return null;
}

module.exports = {
  toolCommand,
  toolEnv,
  parseLastJson
};
