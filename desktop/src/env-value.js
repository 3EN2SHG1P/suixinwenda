/**
 * 文件：desktop/src/env-value.js
 * 职责：解析 KEY=VALUE 形式的配置行——桌面端读 config.env 的唯一实现。
 *
 * 为什么单独成模块：这份逻辑原先在 db-secret.js 与 backend-manager.js 各写了一遍，
 * 两份都按「值里出现 # 就截断」处理，结果密码 `p@ss#1` 被读成 `p@ss`，
 * 表现为「配置看着完全正确但 MySQL 认证失败」。两份实现也只有一份能被测试压住。
 *
 * 注释规则（与 dotenv 一致，且保证密码不被吃掉）：
 * - 值用引号包住：取引号内全部内容，`#` 原样保留；
 * - 未加引号：只有 `#` 前面是空白（` #`）时才算行内注释；
 * - `p@ss#1` 这种 `#` 紧贴内容的，整段都是值。
 */

/** 取 KEY=VALUE 形式某一行的值（去引号 / 去行内注释），取不到返回空串。 */
function parseEnvValue(text, key) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index < 0) {
      continue;
    }
    if (trimmed.slice(0, index).trim() !== key) {
      continue;
    }
    let value = trimmed.slice(index + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[0] === value[value.length - 1]) {
      return value.slice(1, -1);
    }
    // 只有「空白 + #」才是注释起点：`KEY=a#b` 必须整段保留
    const comment = value.search(/[ \t]#/);
    if (comment >= 0) {
      value = value.slice(0, comment).trim();
    }
    return value;
  }
  return '';
}

module.exports = { parseEnvValue };
