#!/usr/bin/env node
/**
 * 桌面端冒烟入口：先拉起假后端，再跑 electron --smoke，退出码原样透传。
 *
 * 为什么需要它：chat / sessions / auth / enhance / rounds 这些场景断言的是
 * 假后端的确定性返回值（固定回复文本、会话 id 恒为 12、匿名列表 2 条），
 * 真后端返回真实模型内容与自增 id，断言必然不成立。
 * 端口选择：先试 8010，若那里已经有「健康检查通过」的真服务就顺延，绝不抢正式后端。
 *
 * offline 场景要的就是后端不在，此时不拉假后端。
 * 用法：`npm run smoke`；指定场景：`SMOKE_SCENARIO=chat npm run smoke`
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CANDIDATE_PORTS = [8010, 8123, 8124, 8125, 8126];
const scenario = process.env.SMOKE_SCENARIO || '';
// 单场景冒烟的总预算：正常 10~30 秒，卡住时必须由脚本自己收场（CI 里没人按 Ctrl+C）
const SMOKE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 180000;
// 1x1 的 PNG，够附件链路验证「缩略图 + 名称 + 大小」三处显示
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// 这个端口上是不是已经有一个「健康检查通过」的后端（真服务或别人起的假后端）
function healthOk(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/v1/health', timeout: 800 },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(text).code === 0);
          } catch (error) {
            resolve(false);
          }
        });
      }
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickPort() {
  for (const port of CANDIDATE_PORTS) {
    if (!(await healthOk(port))) {
      return port;
    }
  }
  return 0;
}

async function waitForMock(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOk(port)) {
      return true;
    }
    await wait(300);
  }
  return false;
}

// 附件与导出两条链路要走系统弹窗；冒烟无人值守，改用环境变量把路径直接喂给主进程
// （主进程 main.js 的 file:pick / file:save-markdown 只在 IS_SMOKE 时认这两个变量）
function prepareSmokeFiles(withRestore) {
  const dir = path.join(os.tmpdir(), `suixinwenda-smoke-files-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const openFile = path.join(dir, '示例图片.png');
  const savePath = path.join(dir, '导出检查.md');
  fs.writeFileSync(openFile, Buffer.from(TINY_PNG, 'base64'));
  // 恢复场景只需要一个「存在的备份包路径」：冒烟不真的执行恢复，内容无所谓
  const restoreFile = path.join(dir, '备份检查.zip');
  if (withRestore) {
    fs.writeFileSync(restoreFile, '');
  }
  return { dir, openFile, savePath, restoreFile };
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // 临时目录删不掉不影响结论，下次系统会自己清
  }
}

async function main() {
  let mock = null;
  let port = 0;
  let smokeDir = '';

  if (scenario !== 'offline') {
    port = await pickPort();
    if (!port) {
      console.error('[smoke] 候选端口上都已有后端在跑，无法拉起假后端');
      process.exit(3);
    }
    mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.js'), '--port', String(port)], {
      stdio: 'ignore'
    });
    // 假后端进程自己退出（最常见是端口被别的程序占着）时要立刻报出来：
    // 否则只会等满 15 秒说「没就绪」，把排查方向指到脚本上
    const mockExited = new Promise((resolve) => {
      mock.once('exit', (code) => resolve(code));
    });
    const ready = await Promise.race([
      waitForMock(port, 15000),
      mockExited.then((code) => {
        console.error(`[smoke] 假后端启动即退出（code=${code}），端口 ${port} 可能被占用`);
        process.exit(3);
      })
    ]);
    if (!ready) {
      console.error(`[smoke] 假后端没能在 15 秒内就绪（端口 ${port}）`);
      mock.kill();
      process.exit(3);
    }
    console.error(`[smoke] 假后端已就绪：http://127.0.0.1:${port}`);
  }

  // 把接口地址透传给页面（主进程 buildSmokeQuery → 页面 URL 参数 apiBase）
  const extraQuery = process.env.SMOKE_QUERY ? `&${process.env.SMOKE_QUERY}` : '';
  const env = Object.assign({}, process.env);
  if (port) {
    env.SMOKE_QUERY = `apiBase=http://127.0.0.1:${port}${extraQuery}`;
  }
  // 需要附件与导出链路的场景（enhance / enhance-view）才备文件，其余场景不额外造东西
  if (scenario === 'enhance' || scenario === 'enhance-view') {
    const files = prepareSmokeFiles(false);
    smokeDir = files.dir;
    env.SMOKE_OPEN_FILE = files.openFile;
    env.SMOKE_SAVE_PATH = files.savePath;
  }
  // 恢复场景只验证「选中备份包后路径回填」，用一个空的 zip 占位即可
  if (scenario === 'restore') {
    const files = prepareSmokeFiles(true);
    smokeDir = files.dir;
    env.SMOKE_RESTORE_FILE = files.restoreFile;
  }

  const electronPath = require('electron'); // electron 包在 Node 里返回可执行文件路径
  const child = spawn(electronPath, ['.', '--smoke'], { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });

  let finished = false;
  const cleanup = () => {
    if (mock && !mock.killed) {
      mock.kill();
    }
    if (smokeDir) {
      removeDir(smokeDir);
    }
  };
  // 总超时：某个 waitUntil 卡住时不能指望人工 Ctrl+C（CI 里会挂到作业超时）
  const hardTimeout = setTimeout(() => {
    console.error(`[smoke] 超过 ${SMOKE_TIMEOUT_MS / 1000} 秒仍未结束，强制退出`);
    finished = true;
    cleanup();
    if (!child.killed) {
      child.kill();
    }
    process.exit(4);
  }, SMOKE_TIMEOUT_MS);

  child.on('error', (error) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(hardTimeout);
    cleanup();
    console.error(`[smoke] 无法启动 Electron：${error && error.message}`);
    process.exit(3);
  });
  child.on('exit', (code, signal) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(hardTimeout);
    cleanup();
    process.exit(signal ? 1 : code == null ? 1 : code);
  });
  process.on('SIGINT', () => {
    finished = true;
    cleanup();
    if (!child.killed) {
      child.kill();
    }
    process.exit(130);
  });
}

main().catch((error) => {
  console.error(`[smoke] 冒烟脚本自身出错：${error && error.message}`);
  process.exit(3);
});
