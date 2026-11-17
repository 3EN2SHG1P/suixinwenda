/**
 * 文件：desktop/tools/build.js
 * 职责：打包入口脚本——先设置国内镜像环境变量，再调用 electron-builder CLI 出
 *      Windows x64 的 NSIS 安装包与 portable 免安装版；
 *      失败时打印原因并以非零码退出，便于判读。
 * 用法：在 desktop/ 下执行 `npm run dist`（= `node tools/build.js`）。
 * 口径：镜像地址、打包目标、图标路径、产物目录全部来自 package.json 的 build 段，本文件不另设默认值。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 1. 国内镜像：必须在调用打包器之前设置，子进程会继承。
//    已在外面设过就尊重外部选择（海外贡献者可用自己的镜像）
const MIRRORS = {
  ELECTRON_MIRROR: 'https://registry.npmmirror.com/-/binary/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
};
Object.keys(MIRRORS).forEach((key) => {
  if (!process.env[key]) {
    process.env[key] = MIRRORS[key];
  }
});

// 2. 打包参数：目标 nsis + portable、架构 x64，打包前不发布
const desktopRoot = path.join(__dirname, '..');
const builderCli = path.join(desktopRoot, 'node_modules', 'electron-builder', 'cli.js');
const CLI_ARGS = [builderCli, '--win', 'nsis', 'portable', '--x64', '--publish', 'never'];
// 后端产物：extraResources 直接引用 backend/dist 下的这个目录，不复制、只校验
const backendExe = path.join(desktopRoot, '..', 'backend', 'dist', 'suixinwenda-backend', 'suixinwenda-backend.exe');
// 第三方许可全文：同样由 extraResources 拷进安装包（desktop/build/ 下，已入库）
const licenseFile = path.join(desktopRoot, 'build', 'THIRD-PARTY-LICENSES.txt');

// 3. 执行打包：默认先打后端再打桌面端；--app-only 只打桌面端（改 UI 时快速迭代）
function main() {
  const appOnly = process.argv.includes('--app-only');
  console.log('[DIST] 开始打包：目标 nsis + portable（Windows x64）');
  console.log(`[DIST] ELECTRON_MIRROR=${process.env.ELECTRON_MIRROR}`);
  console.log(`[DIST] ELECTRON_BUILDER_BINARIES_MIRROR=${process.env.ELECTRON_BUILDER_BINARIES_MIRROR}`);

  if (!appOnly) {
    // 串行调用同目录脚本：失败时 process.exit(1)，不会走到 electron-builder
    const backend = spawnSync(process.execPath, [path.join(__dirname, 'build-backend.js')], {
      cwd: desktopRoot,
      stdio: 'inherit',
      env: process.env
    });
    if (backend.status !== 0) {
      console.error('[DIST] FAIL 后端打包未完成，已中止（安装版会是一个连不上后端的空壳）');
      process.exit(backend.status || 1);
    }
  }

  // 提前校验：缺后端产物时 electron-builder 只会报一条看不懂的路径错误
  if (!fs.existsSync(backendExe)) {
    console.error(`[DIST] FAIL 缺少后端产物：${backendExe}`);
    console.error('[DIST] 先执行 `npm run build:backend`（需要 backend/ 下装好 uv 与 pyinstaller）');
    process.exit(1);
  }

  // 许可全文会被 extraResources 原样拷进安装包：文件不存在时 electron-builder 只会跳过它，
  // 产出一个「少一份合规文件」的包却照样 PASS
  if (!fs.existsSync(licenseFile)) {
    console.error(`[DIST] FAIL 缺少第三方许可全文：${licenseFile}`);
    console.error('[DIST] 先执行 `npm run licenses`（需要 backend/ 下跑过 uv sync）');
    process.exit(1);
  }
  // 依赖变了却没重新生成时，包里带的是上一版许可文本——不会有任何报错，只能在这里拦。
  // 只校验完整打包：dist:app 用于改 UI 快速迭代，不重装后端依赖，不该被它挡住。
  if (!appOnly) {
    checkLicenses();
  }

  const result = spawnSync(process.execPath, CLI_ARGS, {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    console.error(`[DIST] FAIL 打包失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[DIST] FAIL 打包失败：electron-builder 退出码 ${result.status}`);
    process.exit(result.status || 1);
  }
  console.log('[DIST] PASS 打包完成，产物见 desktop/dist/');
  writeReleaseFiles();
  console.log('[DIST] 建议接着跑 `npm run verify:packaged` 自检后端与工具子命令');
}

/**
 * 校验 build/THIRD-PARTY-LICENSES.txt 与当前依赖是否一致。
 *
 * 为什么放在打包里而不是 CI：许可全文是从**打包机自己的** Python 环境生成的，
 * 换平台或换解释器小版本，wheel 里携带的许可文件都可能不同，放进 CI 会因平台差异误报红；
 * 而这里与产物同源，报告不一致就只剩下一个原因——依赖变了却忘了重新生成。
 * 用 uv 而不是裸 python：与 build-backend 同一个前置，且读的就是 uv 维护的那份环境。
 */
function checkLicenses() {
  const result = spawnSync('uv', ['run', 'python', path.join(__dirname, 'gen-licenses.py'), '--check'], {
    cwd: path.join(desktopRoot, '..', 'backend'),
    encoding: 'utf8',
    env: process.env
  });
  if (result.error) {
    // 不开 shell：uv 在 Windows 上也是 uv.exe，与 build-backend.js 的口径一致
    console.error(`[DIST] FAIL 无法执行许可校验（需要 uv，与 build:backend 同一前置）：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    console.error('[DIST] FAIL 第三方许可全文与当前依赖不一致，包里会带上一版文本');
    console.error('[DIST] 处理：cd desktop && npm run licenses，然后重跑本条命令');
    process.exit(1);
  }
  console.log('[DIST] 许可全文与当前依赖一致');
}

/**
 * 出包后生成 SHA256SUMS.txt 与「安装说明.txt」。
 *
 * 为什么需要：exe 没有代码签名，对方无法从「发布者」判断文件是不是原版；
 * 哈希是他们唯一能核对的东西（企业环境也常按哈希加白名单）。
 * 说明文件放在安装包旁边，省得对方还要回头找文档。
 */
function writeReleaseFiles() {
  const crypto = require('node:crypto');
  const distDir = path.join(desktopRoot, 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const version = String(pkg.version || '0.0.0');
  const product = pkg.build && pkg.build.productName ? pkg.build.productName : 'SuiXinWenDa';

  const targets = [`${product}-Setup-${version}.exe`, `${product}-Portable-${version}.exe`]
    .map((name) => path.join(distDir, name))
    .filter((file) => fs.existsSync(file));
  if (!targets.length) {
    // 改了 productName / artifactName / 版本号时会走到这里：不能静默跳过，
    // 否则发版方看到 PASS 却既没有 SHA256SUMS.txt 也没有安装说明
    console.error(
      `[DIST] FAIL 没找到安装包（期望 ${product}-Setup-${version}.exe / ${product}-Portable-${version}.exe），`
        + '请检查 package.json 的 productName、artifactName 与版本号是否一致'
    );
    process.exit(1);
  }

  const lines = targets.map((file) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${hash}  ${path.basename(file)}`;
  });
  fs.writeFileSync(path.join(distDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');

  const readme = [
    `${product} ${version} 安装说明`,
    '',
    '一、安装',
    '  双击 SuiXinWenDa-Setup-<版本>.exe。首次运行 Windows 会提示「Windows 已保护你的电脑 /',
    '  未知发布者」（安装包没有代码签名），点「更多信息 → 仍要运行」即可。',
    '  不想安装就用 SuiXinWenDa-Portable-<版本>.exe，它不写注册表，放在任意目录都能运行。',
    '',
    '二、核对文件完整性',
    '  同目录的 SHA256SUMS.txt 里有每个安装包的 SHA256。PowerShell 里核对：',
    '    Get-FileHash .\\SuiXinWenDa-Setup-' + version + '.exe -Algorithm SHA256',
    '  与文件里的值一致才说明文件没被替换过。',
    '',
    '三、首次启动',
    '  双击图标后先出现启动小窗（首次约 3~5 秒），主窗口出现即后端已就绪。',
    '  数据保存在 %APPDATA%\\suixinwenda-desktop（会话、附件、备份、配置），不联网上传。',
    '',
    '四、添加模型（填 API Key）',
    '  软件不自带任何模型 Key：打开 设置 → 模型，点「添加模型」，',
    '  填 Base URL、API Key、模型 ID（例如 DeepSeek：https://api.deepseek.com/v1 +',
    '  deepseek-chat + 你在开放平台申请的 Key）。保存后自动重启本地服务（约 2 秒），',
    '  模型出现在聊天下拉里即可对话。每个模型用自己的 Key，互不影响。',
    '',
    '五、卸载',
    '  设置 → 应用 → 已安装的应用 → 随心问答 → 卸载。',
    '  **常规卸载不会删除你的数据**：会话、附件、备份与配置仍留在',
    '  %APPDATA%\\suixinwenda-desktop，重装后会自动接上。',
    '  注意：那里是明文聊天记录（模型 Key 已用系统能力加密），如要彻底清除，',
    '  请运行开始菜单里的「随心问答 - 彻底卸载（含本地数据）」（会二次确认）。',
    '  如果安装目录被移动/删除导致卸载入口失效，用开始菜单里的',
    '  「随心问答 - 彻底卸载（保留数据 / 含本地数据）」。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(distDir, '安装说明.txt'), readme, 'utf8');

  console.log('[DIST] 已生成 dist/SHA256SUMS.txt 与 dist/安装说明.txt');
}

main();
