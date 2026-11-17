/**
 * 文件：desktop/tools/build-backend.js
 * 职责：把后端打成 onedir（PyInstaller），供 electron-builder 放进 resources/backend。
 * 用法：在 desktop/ 下执行 `npm run build:backend`（`npm run dist` 会自动先跑它）。
 *
 * 为什么单独一个脚本：出包时最常见的失败是「后端产物没生成 / 生成在别处」，
 * 让 electron-builder 去报一条 `cannot find ...` 的路径错误，人会先怀疑打包配置。
 * 这里提前检查 uv 与产物，失败时直接给「跑哪条命令」。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopRoot = path.join(__dirname, '..');
const backendDir = path.join(desktopRoot, '..', 'backend');
const specFile = 'suixinwenda-backend.spec';
const outDir = path.join(backendDir, 'dist', 'suixinwenda-backend');
const exePath = path.join(outDir, 'suixinwenda-backend.exe');

function fail(text) {
  console.error(`[BACKEND] FAIL ${text}`);
  process.exit(1);
}

/**
 * 生成 PyInstaller 的版本资源文件。
 *
 * 为什么必须有：没有版本信息的 exe（公司/产品/版本全空）在 SmartScreen 与杀软评分里
 * 是一个明显减分项——它和「随手编译的未知程序」长得一样。桌面端 exe 由 electron-builder
 * 自动写入这些字段，后端 exe 不会，只能自己给。
 *
 * 字段取自 desktop/package.json，避免版本号两处漂移。
 */
function writeVersionInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const version = String(pkg.version || '0.0.0');
  const parts = version.split('.').map((item) => parseInt(item, 10) || 0);
  while (parts.length < 4) {
    parts.push(0);
  }
  const company = String(pkg.author || 'SuiXinWenDa contributors');
  const product = String(pkg.build && pkg.build.productName ? pkg.build.productName : 'SuiXinWenDa');
  const text = `VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=(${parts.slice(0, 4).join(', ')}),
    prodvers=(${parts.slice(0, 4).join(', ')}),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable(
        u'040904B0',
        [
          StringStruct(u'CompanyName', u'${company}'),
          StringStruct(u'FileDescription', u'${product} backend service and tools'),
          StringStruct(u'FileVersion', u'${version}'),
          StringStruct(u'InternalName', u'suixinwenda-backend'),
          StringStruct(u'LegalCopyright', u'MIT License'),
          StringStruct(u'OriginalFilename', u'suixinwenda-backend.exe'),
          StringStruct(u'ProductName', u'${product}'),
          StringStruct(u'ProductVersion', u'${version}')
        ]
      )
    ]),
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)
`;
  const target = path.join(backendDir, 'build', 'version_info.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  console.log(`[BACKEND] 版本资源：${version}（${company}）`);
}

function main() {
  if (!fs.existsSync(path.join(backendDir, specFile))) {
    fail(`找不到 ${specFile}：需要在 backend/ 下打包，请检查仓库是否完整`);
  }
  writeVersionInfo();
  console.log('[BACKEND] 开始打包后端（PyInstaller onedir，约 1-3 分钟）…');

  // uv 负责解释器与依赖：不直接用系统 python，避免「本机 python 版本对不上」
  // 不开 shell：uv 在 Windows 上也是 uv.exe，直接 CreateProcess 即可；
  // 开 shell 会把参数拼成命令行（Node 会警告注入风险），而这里的参数本来就固定
  const result = spawnSync('uv', ['run', 'pyinstaller', '--clean', '--noconfirm', specFile], {
    cwd: backendDir,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    fail(`无法执行 uv（${result.error.message}）：请先安装 uv 并在 PATH 里可用`);
  }
  if (result.status !== 0) {
    fail(`PyInstaller 退出码 ${result.status}，上面是它的输出`);
  }
  if (!fs.existsSync(exePath)) {
    fail(`打包成功但没有产物：${exePath}`);
  }
  const sizeMb = (dirSize(outDir) / 1024 / 1024).toFixed(1);
  console.log(`[BACKEND] PASS 产物：${exePath}（目录共 ${sizeMb} MB）`);
}

/** 目录大小只用于提示体积，不算关键路径：读失败返回 0，不让它打断出包。 */
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch (error) {
      // 被占用/权限不足的文件跳过
    }
  }
  return total;
}

main();
