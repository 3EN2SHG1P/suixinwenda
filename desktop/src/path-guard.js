/**
 * 文件：desktop/src/path-guard.js
 * 职责：把「渲染进程传来的路径 / 文件名」收敛到本进程允许操作的范围——纯函数，可单测。
 *
 * 为什么单独成模块：main.js 需要 electron 才能加载，而这两条判定是安全边界的最后一道闸，
 * 必须能被 `node --test` 直接压负面用例（`..` 穿越、盘符切换、大小写、可执行后缀）。
 *
 * 威胁模型：渲染进程被注入（例如 Markdown 渲染漏了一处）时，它能调用的每个 IPC 都变成攻击面。
 * `shell.openPath` 对 .exe / .bat / .lnk 就是「直接运行」，所以「能传什么路径」必须由主进程定。
 */

const path = require('path');

// 允许交给系统程序打开的附件后缀。
// 唯一源 = backend/core/files.py 的 SUPPORTED_EXTS（解析器认哪些，这里才允许打开哪些）。
// 为什么是白名单：黑名单永远漏（.lnk / .url / .hta / .js / .bat / .vbs / .ps1 ...），
// 而 `shell.openPath` 对可执行文件等于「直接运行」。
const OPENABLE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.docx',
  '.xlsx',
  '.xlsm',
  '.md',
  '.txt',
  '.csv',
  '.json'
]);

/** Windows 的路径比较不区分大小写；其它平台区分，否则 /tmp/A 与 /tmp/a 会被误判为同一个。 */
function normalizeForCompare(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * target 是否在 root 之内（含 root 本身）。
 *
 * 必须用「前缀 + 分隔符」而不是裸 startsWith：否则 `C:\data\backups-evil` 会被判成在
 * `C:\data\backups` 之内——这类「同前缀兄弟目录」是最常见的白名单绕过写法。
 */
function isInside(root, target) {
  if (!root || !target) {
    return false;
  }
  const base = normalizeForCompare(root);
  const full = normalizeForCompare(target);
  if (full === base) {
    return true;
  }
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return full.startsWith(prefix);
}

/**
 * target 是否可以交给「定位到资源管理器」这类系统动作。
 *
 * allowedPaths 由调用方给：本应用的产物根目录（备份 / 导出 / 自动备份）与产物记录里的绝对路径。
 * 记录里可以有任何位置（用户把备份存到桌面是正常需求），所以白名单是「目录 + 具体文件」的并集。
 */
function isRevealAllowed(target, allowedPaths) {
  if (typeof target !== 'string' || !target.trim()) {
    return false;
  }
  const list = Array.isArray(allowedPaths) ? allowedPaths : [];
  return list.some((item) => typeof item === 'string' && item && isInside(item, target));
}

/**
 * 附件是否属于「可以交给系统默认程序打开」的类型。
 *
 * 取不到扩展名（`.exe` 这种以点开头的名字、无后缀、`a.tar.gz` 只认最后一段）一律拒绝：
 * 拒绝的代价只是让用户点「另存为」，放行的代价可能是执行任意程序。
 */
function isOpenableAttachment(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return OPENABLE_EXTS.has(ext);
}

module.exports = {
  OPENABLE_EXTS,
  isInside,
  isRevealAllowed,
  isOpenableAttachment
};
