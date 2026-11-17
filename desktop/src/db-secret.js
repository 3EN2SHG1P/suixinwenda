/**
 * 文件：desktop/src/db-secret.js
 * 职责：MySQL 密码在配置文件里的存法——加密写入、读取时解密、旧明文自动迁移。
 *
 * 为什么单独成模块：这段逻辑同时决定「配置文件里能不能 grep 到密码」和
 * 「后端能不能拿到密码启动」，写错任意一半都是「功能正常但密码泄露」或「配置对了却起不来」。
 * 加密/解密函数由调用方注入（真实场景是 Electron safeStorage），测试里用可逆的假实现。
 *
 * 文件里的两种键：
 * - DB_PASSWORD_ENC：safeStorage 加密后的 base64，桌面端写的就是它；
 * - DB_PASSWORD：历史明文。只在「用户手写 .env / 系统没有可用密钥环」时出现，
 *   桌面端读到后会把它迁移成 ENC 并删掉明文。
 */
const { parseEnvValue } = require('./env-value');

const ENC_KEY = 'DB_PASSWORD_ENC';
const PLAIN_KEY = 'DB_PASSWORD';

/** 取 KEY=VALUE 形式的某一行的值（唯一实现见 env-value.js）。 */
function readValue(text, key) {
  return parseEnvValue(text, key);
}

/** 删除某个键的所有行（含 `# KEY=...` 注释模板？不删：模板是给人看的说明）。 */
function dropKey(text, key) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.filter((line) => line.trim().split('=')[0].trim() !== key || line.trim().startsWith('#')).join('\n');
}

/** 写入/替换某个键：保留其它行与注释。 */
function upsertKey(text, key, value) {
  const source = String(text || '');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  const trimmed = source.replace(/\s*$/, '');
  return `${trimmed}${trimmed ? '\n' : ''}${line}\n`;
}

/**
 * 读出当前密码。
 *
 * 顺序：ENC 优先（那是应用写的最新值），解不开才回落到明文——
 * 用户手改过 .env 的明文行时，尊重他刚写的那份，同时标记 needsMigration 让调用方去迁移。
 * 返回 { password, needsMigration }。
 */
function readSecret(text, decrypt, report) {
  const notify = typeof report === 'function' ? report : (message) => console.warn(message);
  const encrypted = readValue(text, ENC_KEY);
  const plain = readValue(text, PLAIN_KEY);
  if (encrypted) {
    try {
      const value = typeof decrypt === 'function' ? decrypt(encrypted) : '';
      if (value) {
        return { password: value, needsMigration: false };
      }
    } catch (error) {
      // 换机器 / 重装系统后 DPAPI 解不开旧密文：退回明文（如果有），否则按空处理。
      // 打包版没有控制台，所以调用方要把 report 接到 main.log，否则用户只看到「缺少配置项」
      notify(`[数据库密码] 解密失败（需要重新填写密码）：${error.message}`);
    }
    // 密文解不开时必须看明文：老版本留下的明文行是唯一能用的那份
    return { password: plain, needsMigration: false };
  }
  return { password: plain, needsMigration: Boolean(plain) };
}

/**
 * 把密码写成密文，并删掉明文行。
 *
 * encrypt 返回空串表示「当前系统没有可用加密」：此时保留明文写入（与 auth.bin 的降级口径一致），
 * 宁可密码明文也不是「应用直接起不来」——但会在日志里明确告警。
 */
function writeSecret(text, password, encrypt, report) {
  const notify = typeof report === 'function' ? report : (message) => console.warn(message);
  const value = String(password == null ? '' : password);
  if (!value) {
    return String(text || '');
  }
  const token = typeof encrypt === 'function' ? encrypt(value) : '';
  if (!token) {
    // 注释里一直承诺「会在日志里明确告警」，但之前根本没日志：数据库口令就这样静默明文落盘
    notify('[数据库密码] 系统加密不可用，密码将以明文写入配置文件（请限制该文件权限）');
    return upsertKey(dropKey(text, ENC_KEY), PLAIN_KEY, value);
  }
  return upsertKey(dropKey(text, PLAIN_KEY), ENC_KEY, token);
}

module.exports = {
  ENC_KEY,
  PLAIN_KEY,
  readValue,
  dropKey,
  upsertKey,
  readSecret,
  writeSecret
};
