/**
 * 文件：desktop/tools/sync-version.js
 * 职责：版本号单一来源——以 desktop/package.json 的 version 为准，同步其余引用
 *       （backend/pyproject.toml、README 双语徽章、渲染层设置页的关于版本常量、package-lock）。
 *
 * 为什么用脚本而不是构建期注入：本项目没有打包器（硬约束：不引入 webpack/vite 等），
 * 而 pyproject.toml 改成动态版本会引入构建后端依赖；只在发布前跑一次脚本成本最低。
 *
 * 用法：
 *   node tools/sync-version.js          # 把 package.json 的版本写进另外三处
 *   node tools/sync-version.js --check  # 只检查，不一致时退出码 1（CI 用）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');

const PACKAGE_JSON = path.join(desktopRoot, 'package.json');
const PYPROJECT = path.join(repoRoot, 'backend', 'pyproject.toml');
const README_FILES = [path.join(repoRoot, 'README.md'), path.join(repoRoot, 'README.en.md')];
const SETTINGS_VIEW = path.join(desktopRoot, 'src', 'renderer', 'views', 'settings.js');
const PACKAGE_LOCK = path.join(desktopRoot, 'package-lock.json');

// README 里的版本只出现在 shields 徽章上：图片地址与 alt 文本各一处，两者都要同步，
// 否则徽章显示 9.9.9、无障碍读屏与鼠标悬停仍是旧版本
const BADGE_SRC_PATTERN = /version-\d+\.\d+\.\d+-informational/g;
const BADGE_ALT_PATTERN = /alt="Version \d+\.\d+\.\d+"/g;

// 设置页「关于」显示的版本号是渲染层里的硬编码常量，不读 package.json；
// 漏同步就会出现「徽章显示 0.1.0、设置页仍显示旧版本」这种对外可见的错位
const SETTINGS_VERSION_PATTERN = /const VERSION = '\d+\.\d+\.\d+';/;

// package-lock 里 root 包的 version 有两处（顶层与 packages[""]），依赖包的 version 缩进与
// 上下文都不同，这里用包名 + 紧随的 version 锁定，避免误改到第三方依赖；
// 漏同步会让 `npm ci` 判定 package.json 与 lock 不同步而在 CI 直接失败
const LOCK_VERSION_PATTERN = /("name": "suixinwenda-desktop",\s*\n\s*"version": ")\d+\.\d+\.\d+(")/g;

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  if (!pkg.version) {
    throw new Error('desktop/package.json 缺少 version');
  }
  return pkg.version;
}

/** 生成「目标文件应有的内容」列表；同步与检查共用同一套变换，避免两边规则漂移。 */
function targets(version) {
  const list = [];

  const pyproject = fs.readFileSync(PYPROJECT, 'utf8');
  // 注意：必须用 test 判断「能不能匹配」，不能拿 replace 前后是否相同来判断——
  // 版本号本来就一致时替换结果当然相同，那样会把「已经同步」误报成「结构变了」
  const versionLine = /(\[project\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
  if (!versionLine.test(pyproject)) {
    throw new Error('backend/pyproject.toml 里找不到 [project] 段落的 version 行');
  }
  const pyprojectNext = pyproject.replace(versionLine, `$1${version}$2`);
  list.push({ file: PYPROJECT, before: pyproject, after: pyprojectNext });

  for (const file of README_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    list.push({
      file,
      before: text,
      // 徽章被删掉时两处都静默跳过（不影响发布脚本）
      after: text
        .replace(BADGE_SRC_PATTERN, `version-${version}-informational`)
        .replace(BADGE_ALT_PATTERN, `alt="Version ${version}"`)
    });
  }

  const settingsView = fs.readFileSync(SETTINGS_VIEW, 'utf8');
  if (!SETTINGS_VERSION_PATTERN.test(settingsView)) {
    throw new Error("desktop/src/renderer/views/settings.js 里找不到 `const VERSION = 'x.y.z';` 行");
  }
  list.push({
    file: SETTINGS_VIEW,
    before: settingsView,
    after: settingsView.replace(SETTINGS_VERSION_PATTERN, `const VERSION = '${version}';`)
  });

  const packageLock = fs.readFileSync(PACKAGE_LOCK, 'utf8');
  // 带 g 的正则用 test 会推进 lastIndex，先归零再判断，避免第二次调用漏判
  LOCK_VERSION_PATTERN.lastIndex = 0;
  if (!LOCK_VERSION_PATTERN.test(packageLock)) {
    throw new Error('desktop/package-lock.json 里找不到 root 包的 name / version 行');
  }
  list.push({
    file: PACKAGE_LOCK,
    before: packageLock,
    after: packageLock.replace(LOCK_VERSION_PATTERN, `$1${version}$2`)
  });

  return list;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const version = readVersion();
  const changed = [];
  const stale = [];

  for (const item of targets(version)) {
    if (item.before === item.after) {
      continue;
    }
    if (checkOnly) {
      stale.push(path.relative(repoRoot, item.file));
      continue;
    }
    fs.writeFileSync(item.file, item.after, 'utf8');
    changed.push(path.relative(repoRoot, item.file));
  }

  if (checkOnly) {
    if (stale.length) {
      console.error(`[version] 版本号不一致（以 package.json 的 ${version} 为准）：${stale.join('、')}`);
      console.error('[version] 运行 `npm run version:sync` 修复');
      process.exit(1);
    }
    console.log(`[version] 全部引用一致：${version}`);
    return;
  }
  console.log(
    changed.length ? `[version] 已同步为 ${version}：${changed.join('、')}` : `[version] 已是 ${version}`
  );
}

main();
