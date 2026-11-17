/**
 * 文件：desktop/src/delete-guard.js
 * 职责：产物删除前的路径闸门——纯逻辑，可单测。
 *
 * 为什么需要独立一层：产物清单（config.json 的 artifacts）由主进程维护，但它是磁盘上的
 * 普通文件，被手改坏、迁移出错或被别的程序写脏时，一次 `rmSync(path, {recursive:true})`
 * 就可能删掉用户主目录。业务侧的「记录即授权」挡不住这种情况，只能在这里做与业务无关的兜底。
 *
 * 不 require('electron')：受保护目录由调用方注入，测试里能直接给假路径。
 */

/**
 * 判断某个路径能不能作为删除目标。
 *
 * 返回 { ok, path?, missing?, error? }：
 * - ok=false 时 error 是可以直接展示给用户的中文原因；
 * - missing=true 表示目标已经不存在（删除记录仍然合法，rmSync 是空操作）。
 */
function checkDeleteTarget(target, options) {
  const opts = options || {};
  const fs = opts.fs;
  const path = opts.path;
  const guarded = Array.isArray(opts.protectedPaths) ? opts.protectedPaths : [];
  const resolved = path.resolve(String(target || ''));

  if (!resolved || path.dirname(resolved) === resolved) {
    return { ok: false, error: '不能删除磁盘根目录' };
  }

  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: true, path: resolved, missing: true };
    }
    return { ok: false, error: `无法检查删除目标：${error.message}` };
  }
  // 用 lstat：rmSync 对符号链接是删链接本身，但「链接指向哪里」不该由我们决定；
  // 记录里的路径本来也不该是链接
  if (stat.isSymbolicLink()) {
    return { ok: false, error: '不删除符号链接指向的位置' };
  }

  const lower = resolved.toLowerCase();
  const protectedHit = guarded.some((item) => String(item || '').toLowerCase() === lower);
  if (protectedHit) {
    return { ok: false, error: '这个位置受保护，不能作为产物删除' };
  }
  return { ok: true, path: resolved, missing: false };
}

module.exports = { checkDeleteTarget };
