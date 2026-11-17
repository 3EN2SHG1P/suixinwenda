/**
 * 文件：desktop/src/artifacts.js
 * 职责：备份 / 导出产物的列举、路径校验与删除。
 *
 * 为什么单独成模块：删除是不可逆操作，路径校验必须能被单测压住（`..`、绝对路径、跨根）。
 * 本模块不 require('electron')，文件系统与根目录都由调用方注入，测试里用临时目录跑。
 */
const fsSync = require('node:fs');
const nodePath = require('node:path');

const KIND_LABELS = {
  backup: '手动备份',
  export: '数据导出',
  // 自动备份池包含升级前 / 恢复前 / 定期（before-auto）三种来源，标签不区分具体前缀
  'auto-backup': '自动备份'
};
const MAX_ITEMS = 20;

function dirSize(dir, fs) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full, fs) : fs.statSync(full).size;
    } catch (error) {
      // 单个文件读不到不影响整体体积统计
    }
  }
  return total;
}

/**
 * 异步版体积统计：递归目录时用 fs.promises，让出事件循环。
 * 同步版 dirSize 在主进程里跑大目录会把窗口卡成「未响应」——UI 线程就是主进程。
 */
async function dirSizeAsync(dir, fsPromises) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return 0;
  }
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name);
    try {
      total += entry.isDirectory()
        ? await dirSizeAsync(full, fsPromises)
        : (await fsPromises.stat(full)).size;
    } catch (error) {
      // 单个文件读不到不影响整体体积统计
    }
  }
  return total;
}

/** 列产物（异步版）：返回结构与 listArtifacts 完全一致，供主进程 IPC 使用。 */
async function listArtifactsAsync(roots, options = {}) {
  const fsPromises = options.fsPromises || fsSync.promises;
  const items = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fsPromises.readdir(root.dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = nodePath.join(root.dir, entry.name);
      let stat;
      try {
        stat = await fsPromises.stat(full);
      } catch (error) {
        continue;
      }
      items.push({
        id: `${root.kind}/${entry.name}`,
        kind: root.kind,
        label: KIND_LABELS[root.kind] || root.kind,
        name: entry.name,
        path: full,
        isDir: entry.isDirectory(),
        size: entry.isDirectory() ? await dirSizeAsync(full, fsPromises) : stat.size,
        createdAt: Math.round(stat.mtimeMs)
      });
    }
  }
  items.sort((left, right) => right.createdAt - left.createdAt);
  return items.slice(0, options.limit || MAX_ITEMS);
}

/** 列产物（按修改时间倒序，最多 limit 条）。目录不存在时静默跳过。 */
function listArtifacts(roots, options = {}) {
  const fs = options.fs || fsSync;
  const items = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = nodePath.join(root.dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        continue;
      }
      items.push({
        id: `${root.kind}/${entry.name}`,
        kind: root.kind,
        label: KIND_LABELS[root.kind] || root.kind,
        name: entry.name,
        path: full,
        isDir: entry.isDirectory(),
        size: entry.isDirectory() ? dirSize(full, fs) : stat.size,
        createdAt: Math.round(stat.mtimeMs)
      });
    }
  }
  items.sort((left, right) => right.createdAt - left.createdAt);
  return items.slice(0, options.limit || MAX_ITEMS);
}

/**
 * 把 id 解析成绝对路径；任何越界形态一律返回 null。
 *
 * 拒绝的形态：`..`、子路径、反斜杠、绝对路径、空名、未知 kind。
 * 不靠「前缀匹配」判断越界：`C:\a\b` 与 `C:\a\bc` 的前缀相同，用 dirname 相等才可靠。
 */
function resolveArtifact(roots, id) {
  if (typeof id !== 'string') {
    return null;
  }
  const index = id.indexOf('/');
  if (index <= 0) {
    return null;
  }
  const kind = id.slice(0, index);
  const name = id.slice(index + 1);
  if (!name || name === '.' || name === '..' || name.includes('\0')) {
    return null;
  }
  if (name.includes('/') || name.includes('\\') || nodePath.isAbsolute(name)) {
    return null;
  }
  const root = roots.find((item) => item.kind === kind);
  if (!root) {
    return null;
  }
  const base = nodePath.resolve(root.dir);
  const target = nodePath.resolve(base, name);
  if (nodePath.dirname(target) !== base) {
    return null;
  }
  return { kind, path: target, base };
}

/** 删除一个产物（文件或目录）。只删根目录下的直接子项。 */
function deleteArtifact(roots, id, options = {}) {
  const fs = options.fs || fsSync;
  const found = resolveArtifact(roots, id);
  if (!found) {
    return { ok: false, error: '非法的删除目标' };
  }
  try {
    fs.rmSync(found.path, { recursive: true, force: true });
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: `删除失败：${error.message}` };
  }
}

/**
 * 打开产物的方式：目录要「进去」，文件要「定位到所在文件夹」。
 *
 * 导出产物是目录（用户想看里面的 jsonl），备份是 zip（直接打开会弹压缩软件）——
 * 两者用同一个动作会有一半是错的。返回 null 表示路径已不存在。
 */
function revealMode(target, options = {}) {
  const fs = options.fs || fsSync;
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return null;
  }
  return stat.isDirectory() ? 'open' : 'locate';
}

module.exports = {
  listArtifacts,
  listArtifactsAsync,
  resolveArtifact,
  deleteArtifact,
  dirSize,
  dirSizeAsync,
  revealMode
};
