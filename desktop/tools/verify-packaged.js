/**
 * 文件：desktop/tools/verify-packaged.js
 * 职责：打包态自检——用 resources/backend 里的后端 exe 起一次服务、跑一次工具子命令，然后关掉。
 * 用法：`npm run verify:packaged`（先 `npm run dist`，或在 backend/ 下 `npm run build:backend`）。
 *
 * 为什么需要它：安装版没有控制台，出问题只能靠用户描述；而「后端能起、工具能跑、中文不乱码」
 * 这三件事每次打完包都可以在 30 秒内验完，不用装一遍再手点九项。
 *
 * 全部资源都在临时目录里：绝不读写 %APPDATA%\suixinwenda-desktop，也不碰真实数据库。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const desktopRoot = path.join(__dirname, '..');
const PORT = 18010;
const READY_TIMEOUT_MS = 60000;

/** 自检失败一律抛错，由末尾统一退出：直接 process.exit 会跳过 finally，
 *  把后端 exe 与临时目录（含一个占着 18010 的进程）留在机器上，下一次自检必然再失败。 */
function fail(text) {
  throw new Error(text);
}

/** 找要验证的后端 exe：优先打包产物（真实投放位置），其次 backend/dist（还没打桌面端时）。 */
function locateExe() {
  const candidates = [
    path.join(desktopRoot, 'dist', 'win-unpacked', 'resources', 'backend', 'suixinwenda-backend.exe'),
    path.join(desktopRoot, '..', 'backend', 'dist', 'suixinwenda-backend', 'suixinwenda-backend.exe')
  ];
  return candidates.find((item) => fs.existsSync(item)) || '';
}

/** 临时配置：sqlite + 固定 JWT + 临时 DATA_DIR，和打包态启动时读的格式完全一致。 */
function configText(dataDir) {
  return [
    'BACKEND_HOST=127.0.0.1',
    `BACKEND_PORT=${PORT}`,
    'DB_BACKEND=sqlite',
    `DATA_DIR=${dataDir}`,
    `JWT_SECRET=${'v'.repeat(48)}`,
    'JWT_EXPIRE_SECONDS=604800',
    'MOCK_CODE=1234',
    'DEMO_CODE_MODE=1',
    'CODE_EXPIRE_SECONDS=300',
    ''
  ].join('\n');
}

function childEnv(envFile, dataDir) {
  return {
    ...process.env,
    SUIXINWENDA_ENV_FILE: envFile,
    DATA_DIR: dataDir,
    BACKEND_PORT: String(PORT),
    SUIXINWENDA_MANAGED: '1',
    SUIXINWENDA_PARENT_PID: String(process.pid),
    // 与 tool-run.js 同口径：中文 Windows 上不设这两个变量，Python 子进程按 GBK 输出
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}

function probeHealth() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/v1/health', timeout: 3000 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(Boolean(parsed && parsed.code === 0));
          } catch (error) {
            resolve(false);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** 关进程：先关 stdin（后端哨兵据此优雅退出），超时再 taskkill /T 把子进程一起收掉。 */
function shutdown(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.on('exit', finish);
    try {
      child.stdin.end();
    } catch (error) {
      // stdin 已关：直接走强杀兜底
    }
    setTimeout(() => {
      if (!done && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
      setTimeout(finish, 1000);
    }, 5000);
  });
}

/** 跑一个工具子命令，返回解析后的 JSON；输出不是 JSON 说明打包缺模块或编码坏了。 */
function runTool(exe, env, name, args) {
  const result = spawnSync(exe, [name, ...(args || [])], { env, encoding: 'utf8', timeout: 60000 });
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.trim().startsWith('{'));
  if (!line) {
    return { ok: false, error: `没有 JSON 输出（stderr：${String(result.stderr || '').slice(0, 300)}）` };
  }
  try {
    return JSON.parse(line);
  } catch (error) {
    return { ok: false, error: `输出不是合法 JSON：${line.slice(0, 200)}` };
  }
}

async function main() {
  const exe = locateExe();
  if (!exe) {
    fail('找不到后端 exe：先跑 `npm run build:backend` 或 `npm run dist`');
  }
  console.log(`[VERIFY] 后端：${exe}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-verify-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const envFile = path.join(tempRoot, 'config.env');
  fs.writeFileSync(envFile, configText(dataDir), 'utf8');
  const env = childEnv(envFile, dataDir);
  const logFile = path.join(tempRoot, 'backend.log');
  const logFd = fs.openSync(logFile, 'a');

  let child = null;
  try {
    child = spawn(exe, [], { env, stdio: ['pipe', logFd, logFd], windowsHide: true });
    const ready = await waitReady();
    if (!ready) {
      const tail = fs.readFileSync(logFile, 'utf8').slice(-800);
      fail(`后端 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪。日志尾部：\n${tail}`);
    }
    console.log('[VERIFY] PASS 后端起得来（/api/v1/health 返回 code=0）');

    // 工具子命令 1：db_info 必须能跑通 sqlite 诊断（证明 launcher 分派与 sqlalchemy 方言都在）
    const info = runTool(exe, env, 'db_info', []);
    if (!info.ok || info.backend !== 'sqlite') {
      fail(`db_info 子命令不可用：${JSON.stringify(info).slice(0, 300)}`);
    }
    console.log('[VERIFY] PASS 工具子命令可用（db_info：sqlite，ok=true）');

    // 工具子命令 2：给 storage_test 空密码，必须回一句中文——顺带验证 UTF-8 输出没有乱码
    const probe = runTool(exe, env, 'storage_test', []);
    if (!probe.error || !/密码/.test(probe.error)) {
      fail(`storage_test 子命令异常：${JSON.stringify(probe).slice(0, 300)}`);
    }
    console.log('[VERIFY] PASS 工具输出是 UTF-8 中文（未出现 GBK 乱码）');
  } finally {
    await shutdown(child);
    fs.closeSync(logFd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  // 端口必须已释放：残留进程占着 8010 是用户最常见的一次性故障
  if (await probeHealth()) {
    fail('后端已被要求退出但仍在响应，可能有残留进程');
  }
  console.log('[VERIFY] PASS 关闭后无残留进程（端口已释放）');
  console.log('[VERIFY] 全部通过');
}

main().catch((error) => {
  console.error(`[VERIFY] FAIL ${(error && error.message) || error}`);
  process.exit(1);
});
