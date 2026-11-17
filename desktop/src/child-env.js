/**
 * 文件：desktop/src/child-env.js
 * 职责：子进程（后端 / tools/*）的环境变量基线——必须先剔掉外层 shell 里的同名变量。
 *
 * 为什么必须剔：core/config.py 的 load_env() 是「已存在不覆盖」。用户在同一个 shell 里
 * `export DB_HOST=...` 之后再启动应用（README 教过这种启动方式），这份环境变量会压住
 * config.env 里的值，表现为「界面上切换存储成功，实际备份/恢复操作的是另一个库」，
 * 且全程没有任何报错。后端、工具子进程、探测子进程三处必须用同一份黑名单。
 */
const CHILD_ENV_BLOCKLIST = [
  'DB_BACKEND',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_ALLOW_REMOTE',
  'DB_SSL_CA',
  'DB_SSL_NO_VERIFY_IDENTITY',
  'DATA_DIR',
  // 外层 shell 的 BACKEND_HOST=0.0.0.0 会压住 .env（load_env 已存在不覆盖），
  // 托管链路必须自己锁死回环，否则一份手误的 shell 变量就能把聊天记录暴露到局域网
  'BACKEND_HOST'
];

/** 复制一份 baseEnv 并删掉黑名单键（不修改入参）。 */
function stripChildEnv(baseEnv) {
  const env = Object.assign({}, baseEnv || {});
  CHILD_ENV_BLOCKLIST.forEach((key) => {
    delete env[key];
  });
  return env;
}

module.exports = {
  CHILD_ENV_BLOCKLIST,
  stripChildEnv
};
