/**
 * 文件：desktop/src/backend-manager.js
 * 职责：把后端 Python 进程当子资源管理——env 文件维护、拉起、探活、优雅关闭，以及端口残留的甄别。
 *
 * 为什么单独成模块：main.js 已经上千行，而这段逻辑（env 解析、健康轮询、退出顺序、残留判定）
 * 全是纯 Node 逻辑。抽出来才能用 `node --test` 直接压「端口被别的程序占」「健康一直不 ok」这类分支，
 * 而不是每次都靠手工开窗口验证。
 *
 * 不 require('electron')：electron 的能力由调用方注入，测试里用假 app 跑。
 */
// 不叫 crypto：Node 的 globals 里已经有同名 Web Crypto 全局，重名会被 no-redeclare 拦下
const nodeCrypto = require('node:crypto');
const fsSync = require('node:fs');
const nodePath = require('node:path');
const { readSecret, writeSecret } = require('./db-secret');

// 落在配置文件里的说明：为什么密码是密文、手动启动该怎么办
const PLAIN_HINT =
  '# 密码为加密存储（只有桌面端能解密）：桌面端启动会自动解密注入；手动启动后端时请临时写一份明文 DB_PASSWORD';

const DEFAULT_PORT = 8010;
const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30000;
// 打包版首次启动要解压 / 加载 Python 运行时，30 秒不够
const READY_TIMEOUT_PACKAGED_MS = 60000;
const PROBE_TIMEOUT_MS = 1500;
// status() 由页面按需调，探活要比启动时更急，避免点一下状态卡 1.5 秒
const STATUS_PROBE_TIMEOUT_MS = 800;
// 关闭预算必须明显小于 main.js 的硬兜底（8 秒），否则 taskkill 稍慢就会被 app.exit 抢断、留下孤儿
const STOP_GRACE_MS = 2500;
const STOP_KILL_MS = 1500;
// 日志按启动轮转：只追加不清理的话，跑半年就是几百 MB，用户不会自己去删
const LOG_MAX_BYTES = 5 * 1024 * 1024;
// 后端子进程不该继承这些：load_env() 是「已存在则不覆盖」，
// 外层 shell 里的同名变量会压住 .env，表现为「切换显示成功但实际没生效」——排查成本极高。
// 黑名单与环境变量解析都由公共模块提供：tools/* 子进程必须用同一份口径
const { stripChildEnv } = require('./child-env');
const { parseEnvValue } = require('./env-value');
// 监听通配地址时本机不可直达：探活必须换回回环，否则健康检查永远连不上
const WILDCARD_HOSTS = ['0.0.0.0', '::', '[::]', '*'];

/** 读 KEY=VALUE 形式的 env 文本，取某个键的值（唯一实现见 env-value.js）。 */
function parseEnv(text, key) {
  return parseEnvValue(text, key);
}

/**
 * 从健康检查的 db 段里挑出连接表单要回显的四项。
 *
 * 只走白名单：健康检查那边将来多带一个字段（比如密码）也不会顺着 IPC 漏到页面上，
 * 这类「多带一个键」的改动在代码评审里几乎看不出来，只能靠这里挡死。
 */
function connectionOf(db) {
  const source = db && typeof db === 'object' ? db.connection : null;
  if (!source || typeof source !== 'object') {
    return null;
  }
  return {
    host: String(source.host || ''),
    port: String(source.port || ''),
    user: String(source.user || ''),
    name: String(source.name || ''),
    // 连接性质（非机密）：界面靠它决定显示「本机 MySQL」还是「远程 MySQL」、
    // 勾选框要不要打勾、以及有没有走 TLS
    remote: Boolean(source.remote),
    allowRemote: Boolean(source.allow_remote),
    ssl: Boolean(source.ssl),
    sslCa: String(source.ssl_ca || '')
  };
}

/** 替换或追加一个键（保留文件里其它行与注释），返回新文本。 */
function upsertEnv(text, key, value) {
  const source = String(text || '');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  const trimmed = source.replace(/\s*$/, '');
  return `${trimmed}${trimmed ? '\n' : ''}${line}\n`;
}

/** JWT_SECRET 为空时补一个随机的；返回 {text, changed}，changed=false 表示文件不用重写。 */
function ensureJwtSecret(text) {
  const current = parseEnv(text, 'JWT_SECRET');
  if (current) {
    // 非空就绝不动：哪怕长度不足也交给后端报「JWT_SECRET 长度不足」的中文错误。
    // 这里静默换成新值会让所有已签发的令牌立刻失效，用户只会看到「莫名其妙被登出」
    return { text, changed: false };
  }
  const secret = nodeCrypto.randomBytes(48).toString('base64url');
  return { text: upsertEnv(text, 'JWT_SECRET', secret), changed: true };
}

function writeFileAtomic(file, text) {
  fsSync.mkdirSync(nodePath.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsSync.writeFileSync(tmp, text, 'utf8');
    fsSync.renameSync(tmp, file);
  } catch (error) {
    try {
      fsSync.unlinkSync(tmp);
    } catch (cleanupError) {
      // 临时文件删不掉不影响主流程，下次写入会覆盖
    }
    throw error;
  }
}

function createBackendManager(options) {
  const app = options.app;
  const backendDir = options.backendDir;
  const spawnImpl = options.spawn;
  const execFileImpl = options.execFile;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = options.logger || console;
  // 密码加解密由主进程注入（Electron safeStorage）；默认身份实现表示「不加密」，
  // 测试与没有密钥环的环境都走这条，行为与改造前一致
  const encryptSecret = options.encrypt || (() => '');
  const decryptSecret = options.decrypt || (() => '');
  // 时间是注入的：就绪超时要能在测试里快进，否则一条「始终不 ok」的用例要真跑 30 秒
  const now = options.now || Date.now;

  let child = null;
  // stdout / stderr 各用一个 fd：共用同一个 fd 时两条流共享文件偏移，并发写会交错出半行
  let logFdOut = null;
  let logFdErr = null;
  let external = null; // 复用的外部后端（start.ps1 起的），只读不杀
  let lastHealth = null;
  let starting = null;
  // spawn 的失败是异步 'error' 事件（找不到命令不会同步抛），必须存下来让 waitReady 立刻失败，
  // 否则未处理的 'error' 会冒到 uncaughtException，表现成「双击应用直接弹框退出」
  let startError = null;
  // 启动阶段（idle / spawning / waiting / ready / failed）：只给启动小窗推进文案用，
  // 不参与任何「是否可用」的判定——可用性一律以现探的 status() 为准
  let bootPhase = 'idle';

  function envFilePath() {
    return app.isPackaged
      ? nodePath.join(app.getPath('userData'), 'config.env')
      : nodePath.join(backendDir, '.env');
  }

  /** 读当前 env 文件原文；读不到当空串（首次启动还没有这个文件）。 */
  function readEnvText() {
    try {
      return fsSync.readFileSync(envFilePath(), 'utf8');
    } catch (error) {
      return '';
    }
  }

  /**
   * 当前生效的数据库密码（明文）。
   *
   * 后端与工具子进程都只认明文 DB_PASSWORD，密文只存在于配置文件里：
   * 由这里解密后经环境变量注入，所以文件被打开 / grep / 传给别人时都看不到口令。
   */
  function dbPassword() {
    return readSecret(readEnvText(), decryptSecret, (message) => logger.warn(message)).password;
  }

  function logPath() {
    // 打包后 resources/ 只读，日志必须落到 userData，否则连 spawn 都失败
    return app.isPackaged
      ? nodePath.join(app.getPath('userData'), 'logs', 'backend.log')
      : nodePath.join(backendDir, 'backend.log');
  }

  /** 模型配置的运行时文件：明文 Key，供后端在启动时读取（详见 core/models_config.py）。 */
  function runtimeModelsPath() {
    return nodePath.join(app.getPath('userData'), 'runtime', 'models.json');
  }

  /**
   * 把模型配置写给后端。
   *
   * 为什么写临时文件而不是环境变量：模型多了会超过 Windows 的 32K 上限；
   * 文件在 userData/runtime 下、进程退出时删除，只在本机当前用户可见。
   */
  function applyModels(payload) {
    const file = runtimeModelsPath();
    fsSync.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(payload || { default: '', models: [] }), 'utf8');
    // 原子替换：后端可能正好在启动读它，不能让它读到写了一半的 JSON
    fsSync.renameSync(tmp, file);
    // 权限收紧：POSIX 上限制成仅当前用户可读写。Windows 由用户目录自身的 ACL 兜着，
    // chmod 是 no-op，所以这里 best-effort，失败不影响启动（文件里是明文 Key，才值得多这一步）
    try {
      fsSync.chmodSync(file, 0o600);
    } catch (error) {
      logger.warn(`[模型] 收紧运行时配置权限失败（已忽略）：${error.message}`);
    }
    return { ok: true, path: file, models: (payload && payload.models ? payload.models.length : 0) };
  }

  /** 退出时删掉含明文 Key 的运行时文件（失败不拦退出）。 */
  function removeRuntimeModels() {
    try {
      fsSync.rmSync(nodePath.dirname(runtimeModelsPath()), { recursive: true, force: true });
    } catch (error) {
      logger.warn(`[模型] 删除运行时配置失败：${error.message}`);
    }
  }

  function backendPort() {
    let text = '';
    try {
      text = fsSync.readFileSync(envFilePath(), 'utf8');
    } catch (error) {
      text = '';
    }
    const value = parseInt(parseEnv(text, 'BACKEND_PORT') || String(DEFAULT_PORT), 10);
    return value > 0 ? value : DEFAULT_PORT;
  }

  /** 探活用的主机名：.env 里的 BACKEND_HOST 若是通配地址，本机不能直接连，必须换成回环。 */
  function probeHost() {
    let text = '';
    try {
      text = fsSync.readFileSync(envFilePath(), 'utf8');
    } catch (error) {
      text = '';
    }
    const value = (parseEnv(text, 'BACKEND_HOST') || '').trim();
    if (!value || WILDCARD_HOSTS.includes(value.toLowerCase())) {
      return '127.0.0.1';
    }
    // IPv6 字面量拼 URL 必须带方括号，否则 new URL / fetch 直接抛错
    if (value.includes(':') && !value.startsWith('[')) {
      return `[${value}]`;
    }
    return value;
  }

  function healthUrl() {
    return `http://${probeHost()}:${backendPort()}/api/v1/health`;
  }

  function backendCommand() {
    if (app.isPackaged) {
      const resources = process.resourcesPath ? String(process.resourcesPath) : '';
      const exe = resources ? nodePath.join(resources, 'backend', 'suixinwenda-backend.exe') : '';
      if (exe && fsSync.existsSync(exe)) {
        return { cmd: exe, args: [], cwd: nodePath.dirname(exe) };
      }
      throw new Error('打包产物里没有后端可执行文件（resources/backend/suixinwenda-backend.exe）');
    }
    return { cmd: 'uv', args: ['run', 'python', 'run.py'], cwd: backendDir };
  }

  function childEnv(extra) {
    const env = stripChildEnv(process.env);
    // 密文只存在于配置文件，后端要的是明文：这里解密后经环境变量注入。
    // 必须放在 blocklist 之后，否则刚注入的 DB_PASSWORD 会被一起删掉。
    const password = dbPassword();
    if (password) {
      env.DB_PASSWORD = password;
    }
    // 模型配置走文件（见 applyModels）；文件不存在时不注入，后端自动回退到 .env 两模型
    if (fsSync.existsSync(runtimeModelsPath())) {
      env.SUIXINWENDA_MODELS_FILE = runtimeModelsPath();
    }
    return Object.assign(
      env,
      {
        SUIXINWENDA_MANAGED: '1',
        SUIXINWENDA_ENV_FILE: envFilePath(),
        // 托管模式只监听本机回环：与 run.py 的 _host() 双保险，不靠 .env 自觉
        BACKEND_HOST: '127.0.0.1',
        // 后端的 Windows 哨兵靠等这个 pid 的句柄退出：只靠 stdin EOF 不够——
        // uv 作为中间层也持有同一个管道写端，Electron 被杀后 uv 还活着，EOF 永远不来
        SUIXINWENDA_PARENT_PID: String(process.pid)
      },
      extra || {}
    );
  }

  /** env 模板位置：打包后模板随 exe 放在 resources/backend（asar 内只读且未必带模板），开发态在 backend/。 */
  function envTemplatePath() {
    // process.resourcesPath 在单测里是 undefined：拼路径前先判空，
    // 否则测试里拿到的是 TypeError，而不是「找不到模板」这句能照做的中文
    const resources = process.resourcesPath ? String(process.resourcesPath) : '';
    const candidates = app.isPackaged
      ? [resources && nodePath.join(resources, 'backend', '.env.example'), nodePath.join(backendDir, '.env.example')]
      : [nodePath.join(backendDir, '.env.example')];
    return candidates.find((item) => item && fsSync.existsSync(item)) || '';
  }

  /** env 文件不存在就从模板复制；JWT_SECRET 为空就补一个。返回文件路径。 */
  function ensureEnvFile() {
    const file = envFilePath();
    const exists = fsSync.existsSync(file);
    let text = '';
    if (exists) {
      text = fsSync.readFileSync(file, 'utf8');
    } else {
      const template = envTemplatePath();
      if (!template) {
        throw new Error(
          '找不到 env 模板（.env.example）：开发态应位于 backend/，' +
            '打包态需由 extraResources 放进 resources/backend/'
        );
      }
      text = fsSync.readFileSync(template, 'utf8');
    }
    const filled = ensureJwtSecret(text);
    // 老配置里的明文密码迁移成密文——只在打包态做。
    //
    // 为什么开发态不迁移：backend/.env 同时是「手动 uv run uvicorn」的配置（README 一直
    // 这么教），而后端没有解密能力。自动迁移等于把手动启动这条路悄悄堵死，且无路可退。
    // 打包态的 config.env 只由桌面端读写，迁移没有任何副作用。
    // 开发态若要加密，走一次「设置 → 切换存储」即可（那条路径永远写密文）。
    const migrated = app.isPackaged ? migratePassword(filled.text) : { text: filled.text, changed: false };
    // 打包态把 DATA_DIR 钉到 userData/data。必须写进文件而不只是 spawn 时注入：
    // 备份 / 恢复 / 清除等工具子进程的 DATA_DIR 是同一口径注入的，但后端服务进程
    // 的 blocklist 只负责删掉外部环境变量——如果文件里没有这一行，服务进程会回落到
    // exe 旁边的 resources 目录（只读安装时直接写不进去），于是出现「服务连的库」
    // 和「工具操作的库」是两个文件的静默分叉：清除报 no such table、恢复后界面无数据。
    let text2 = migrated.text;
    let dataDirChanged = false;
    if (app.isPackaged) {
      const pinned = upsertEnv(text2, 'DATA_DIR', nodePath.join(app.getPath('userData'), 'data'));
      dataDirChanged = pinned !== text2;
      text2 = pinned;
    }
    if (!filled.changed && !migrated.changed && !dataDirChanged && exists) {
      return file;
    }
    writeFileAtomic(file, text2);
    return file;
  }

  /** 明文密码 → 密文，并删掉明文行；返回 {text, changed}。 */
  function migratePassword(text) {
    const { password, needsMigration } = readSecret(text, decryptSecret, (message) =>
      logger.warn(message)
    );
    if (!needsMigration) {
      return { text, changed: false };
    }
    let next = writeSecret(text, password, encryptSecret, (message) => logger.warn(message));
    if (next === text) {
      return { text, changed: false };
    }
    // 顺手留一行说明：半年后有人拿这份 .env 手动跑 uvicorn，看到「缺少 DB_PASSWORD」
    // 不知道该改哪里——密文只有桌面端能解，这件事必须写在文件里，而不是只写进文档
    if (!next.includes(PLAIN_HINT)) {
      next = next.replace(/^(DB_PASSWORD_ENC=)/m, `${PLAIN_HINT}\n$1`);
    }
    logger.warn('[数据库密码] 检测到明文配置，已改为加密存储');
    return { text: next, changed: true };
  }

  async function probeHealth(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || PROBE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(healthUrl(), { signal: controller.signal });
      const body = await response.json();
      return { reachable: true, ok: Boolean(response.ok && body && body.code === 0), body };
    } catch (error) {
      return { reachable: false, ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  function waitExit(proc, ms) {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        proc.removeListener('exit', onExit);
        resolve(false);
      }, ms);
      function onExit() {
        clearTimeout(timer);
        resolve(true);
      }
      proc.once('exit', onExit);
    });
  }

  function closeLogFd() {
    [logFdOut, logFdErr].forEach((fd) => {
      if (fd === null) {
        return;
      }
      try {
        fsSync.closeSync(fd);
      } catch (error) {
        // 句柄已经关了不算错误
      }
    });
    logFdOut = null;
    logFdErr = null;
  }

  /** 日志超过上限就改名成 .1（只留一份历史，够定位上一次崩溃）。 */
  function rotateLog(logFile) {
    try {
      if (fsSync.statSync(logFile).size > LOG_MAX_BYTES) {
        fsSync.renameSync(logFile, `${logFile}.1`);
      }
    } catch (error) {
      // 文件还不存在是正常情况
    }
  }

  async function killPid(pid) {
    if (!pid) {
      return;
    }
    await new Promise((resolve) => {
      // /T 不能省：uv 会派生 python 子进程，只杀父进程端口不释放
      execFileImpl('taskkill', ['/PID', String(pid), '/T', '/F'], (error) => {
        // 失败必须留痕：以前整个错误被丢掉，stop() 随后照样把 child 置空，
        // 结果「杀不掉」被当成「已停止」，端口仍被旧进程占着
        if (error) {
          logger.warn(`[后端] taskkill PID ${pid} 失败：${error.message}`);
        }
        resolve();
      });
    });
  }

  async function waitReady(logFile) {
    const timeout = app.isPackaged ? READY_TIMEOUT_PACKAGED_MS : READY_TIMEOUT_MS;
    const deadline = now() + timeout;
    while (now() < deadline) {
      if (startError) {
        // spawn 失败（没装 uv / 缺 exe / EACCES）时进程根本没起来，不会有 'exit' 事件：
        // 走 stopInternal 会卡到 waitExit 超时并 throw，而它刻意不在失败路径清 child，
        // 结果 child 残留 → 下次 startInternal 认为「已在跑」直接假成功。
        // 这里直接清掉，不进入杀进程流程。
        child = null;
        closeLogFd();
        throw new Error(
          `后端无法启动（${startError.message}）：开发态请确认已安装 uv，` +
            `打包态请确认 resources/backend 下有后端可执行文件；日志：${logFile}`
        );
      }
      if (!child) {
        throw new Error(`后端进程已退出，请查看日志：${logFile}`);
      }
      const probe = await probeHealth();
      if (probe.ok) {
        lastHealth = probe.body;
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    try {
      await stopInternal();
    } catch (stopError) {
      logger.warn('[后端] 关闭未就绪的进程时出错', stopError);
    }
    throw new Error(`后端在 ${Math.round(timeout / 1000)} 秒内没有就绪，请查看日志：${logFile}`);
  }

  /** 处理上次崩溃留下的端口占用；返回 {action: none|killed|reused}。 */
  async function cleanupStale() {
    const probe = await probeHealth();
    if (!probe.reachable) {
      return { action: 'none' };
    }
    const data = (probe.body && probe.body.data) || {};
    if (!probe.ok) {
      throw new Error(
        `端口 ${backendPort()} 被其它程序占用（健康检查响应不符合本项目），` +
          '请在 backend/.env 改 BACKEND_PORT 换一个空闲端口'
      );
    }
    if (data.managed === true) {
      await killPid(data.pid);
      await sleep(POLL_INTERVAL_MS);
      return { action: 'killed', pid: data.pid };
    }
    // 外部启动的后端（start.ps1 / 手工 uvicorn）：只复用，不杀
    external = { health: probe.body };
    return { action: 'reused' };
  }

  async function startInternal() {
    if (child || external) {
      return await status();
    }
    if (starting) {
      return starting;
    }
    bootPhase = 'spawning';
    starting = (async () => {
      ensureEnvFile();
      // 端口归属不在 spawn 前猜：启动链路先走 cleanupStale（托管残留→杀、外部后端→复用），
      // restart 链路先走 ensurePortReleased。这里如果再探一次，既会多一次请求，
      // 也会让「外部后端」在两条路径上有两套判断。
      // 「spawn 之后探到旧进程就报就绪」的根因已由 stop() 现在会抛错 + restart 的端口校验堵住。
      const logFile = logPath();
      fsSync.mkdirSync(nodePath.dirname(logFile), { recursive: true });
      rotateLog(logFile);
      logFdOut = fsSync.openSync(logFile, 'a');
      logFdErr = fsSync.openSync(logFile, 'a');
      const command = backendCommand();
      startError = null;
      let proc = null;
      try {
        proc = spawnImpl(command.cmd, command.args, {
          cwd: command.cwd,
          windowsHide: true,
          // stdin 必须是 pipe：后端哨兵靠这条管道读 EOF 判断父进程已退出
          stdio: ['pipe', logFdOut, logFdErr],
          env: childEnv({ BACKEND_PORT: String(backendPort()) })
        });
      } catch (error) {
        closeLogFd();
        throw new Error(`后端进程无法启动：${error.message}`);
      }
      child = proc;
      // spawn 已返回、进入健康轮询：环境解析完就等 python 起来了
      bootPhase = 'waiting';
      // 命令不存在（没装 uv）是异步 'error'：接不住就会变成 uncaughtException，
      // 表现成「双击应用直接弹框退出」，而真正原因一个字都看不到
      proc.on('error', (error) => {
        startError = error;
        logger.error('[后端] 子进程错误', error);
      });
      proc.on('exit', (code) => {
        if (child === proc) {
          child = null;
        }
        // 非 stop() 触发的退出（崩溃 / 被杀）也要把阶段退回 idle，
        // 否则小窗会一直停在「正在等待服务响应」
        if (bootPhase !== 'failed') {
          bootPhase = 'idle';
        }
        closeLogFd();
        if (code !== 0 && code !== null) {
          logger.warn(`[后端] 进程退出，code=${code}，日志：${logFile}`);
        }
      });
      await waitReady(logFile);
      bootPhase = 'ready';
      return await status();
    })();
    try {
      return await starting;
    } catch (error) {
      bootPhase = 'failed';
      throw error;
    } finally {
      starting = null;
    }
  }

  async function stopInternal() {
    const proc = child;
    if (!proc) {
      bootPhase = 'idle';
      closeLogFd();
      return;
    }
    try {
      if (proc.stdin) {
        proc.stdin.end(); // 关 stdin 触发哨兵优雅退出
      }
    } catch (error) {
      logger.warn('[后端] 关闭 stdin 失败，将直接强杀', error);
    }
    if (await waitExit(proc, STOP_GRACE_MS)) {
      child = null;
      bootPhase = 'idle';
      closeLogFd();
      return;
    }
    await killPid(proc.pid);
    if (!(await waitExit(proc, STOP_KILL_MS))) {
      // 杀不掉就不能假装停了：保留 child，让上层拿到明确错误。
      // 以前这里无条件 child=null，紧接着 start() 会探到旧进程并报「就绪」，新 env 从未生效
      bootPhase = 'failed';
      closeLogFd();
      throw new Error(
        `无法停止后端进程（PID ${proc.pid}）：请在任务管理器结束它，或退出应用后重试`
      );
    }
    child = null;
    bootPhase = 'idle';
    closeLogFd();
  }

  /** 状态必须现探一次：只回启动时那份快照的话，后端中途挂掉页面还会看到 ok:true。 */
  async function status() {
    const probe = await probeHealth(STATUS_PROBE_TIMEOUT_MS);
    if (probe.ok) {
      lastHealth = probe.body;
    } else {
      // 探不到 / 探到但自检失败（code!=0）都不能沿用旧快照：
      // 旧快照会让页面在后端已经把自检跑挂的情况下继续显示 ok:true
      lastHealth = null;
    }
    const health = (lastHealth && lastHealth.data && lastHealth.data) || null;
    const db = (health && health.db) || null;
    return {
      running: Boolean(child) || Boolean(external) || Boolean(lastHealth),
      managed: Boolean(child),
      ok: Boolean(lastHealth && lastHealth.code === 0),
      bootPhase,
      backend: db ? db.backend : null,
      location: db ? db.location : null,
      // 连接表单回显：只给四项，密码永远不在返回里（见 connectionOf）
      connection: connectionOf(db),
      logFile: logPath()
    };
  }

  /**
   * restart 专用：确认端口真的空出来了再拉新进程。
   *
   * stop() 的强杀路径会无条件把 child 置空；如果旧进程没死透还占着端口，
   * start() 的健康轮询会探到「旧进程还在应答」并立刻当成新进程就绪——
   * 表现是「切换成功」，实际跑的还是旧配置的进程，新 env 从未生效。
   * 所以这里不看进程对象，直接探端口：探不到（unreachable）才算真的停了。
   */
  async function ensurePortReleased() {
    const deadline = now() + STOP_KILL_MS + STOP_GRACE_MS;
    while (now() < deadline) {
      const probe = await probeHealth();
      if (!probe.reachable) {
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('旧的后端进程未能停止（端口仍被占用），请退出应用后重新打开再试');
  }

  /** 改 env 并重启；任何一步失败都用旧配置救回来，不让用户停在「后端起不来」的状态。 */
  async function restartInternal(patch) {
    // 外部启动的后端（start.ps1 / 手动 uvicorn）不受托管：stop() 碰不到它，
    // start() 又会把它当「已就绪」直接复用——env 写了、进程没换，界面却报成功。
    // 与其假成功，不如明说：这不是应用能替用户做的操作。
    if (external && !child) {
      return {
        ok: false,
        error: '当前后端是外部启动的（不受应用托管），应用无法替它重启：请先停掉外部后端（或改由应用启动）再切换存储'
      };
    }
    const file = envFilePath();
    const backup = `${file}.bak`;
    const hasOriginal = fsSync.existsSync(file);
    const original = hasOriginal ? fsSync.readFileSync(file, 'utf8') : '';
    if (hasOriginal) {
      fsSync.writeFileSync(backup, original, 'utf8');
    }
    try {
      ensureEnvFile();
      let text = fsSync.readFileSync(file, 'utf8');
      Object.keys(patch || {}).forEach((key) => {
        if (key === 'DB_PASSWORD') {
          // 密码永远以密文落盘：writeSecret 会同时删掉可能存在的明文行，
          // 否则「换过一次密码」之后文件里还留着旧明文，grep 得到
          text = writeSecret(text, String(patch[key]), encryptSecret, (message) =>
            logger.warn(message)
          );
          return;
        }
        text = upsertEnv(text, key, String(patch[key]));
      });
      writeFileAtomic(file, text);
      await stopInternal();
      await ensurePortReleased();
      await startInternal();
      if (fsSync.existsSync(backup)) {
        fsSync.unlinkSync(backup);
      }
      return { ok: true };
    } catch (error) {
      try {
        if (hasOriginal) {
          writeFileAtomic(file, original);
        }
        await stopInternal();
        await ensurePortReleased();
        await startInternal();
      } catch (recoverError) {
        logger.error('[后端] 回滚后仍启动失败', recoverError);
      }
      // 失败时故意保留 .bak：它是唯一一份「切换前的原文」，留着才能人工比对；
      // 下一次成功的 restart 会覆盖并删除它
      return { ok: false, error: `切换失败，已回到原存储：${error.message}` };
    }
  }

  /**
   * 启停串行化：start / stop / restart 三者共用一条队列。
   *
   * 为什么必须有：启动阶段（main.js 的 startBackendIfNeeded）不在 withTool 里，
   * 用户此时点「切换存储」会与它并发。原来的交叠后果：
   * restart 的 stop 看不到 child（spawn 尚未赋值）→ start 命中 `if (starting) return starting`
   * 复用旧 env 的在飞启动 → 返回 {ok:true}，但新配置根本没生效。
   * 队列只包裹公开入口，内部调用一律走 *Internal，避免自己等自己。
   */
  let active = false;
  const waiting = [];
  function serialize(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active = true;
        const finish = () => {
          active = false;
          const next = waiting.shift();
          if (next) {
            next();
          }
        };
        let value;
        try {
          // 同步调用：队列空闲时第一个任务与改造前一样立刻开始（bootPhase 等副作用
          // 在调用返回前就已发生，调用方不必多等一个微任务）
          value = task();
        } catch (error) {
          finish();
          reject(error);
          return;
        }
        Promise.resolve(value).then(
          (result) => {
            finish();
            resolve(result);
          },
          (error) => {
            finish();
            reject(error);
          }
        );
      };
      if (active) {
        waiting.push(run);
      } else {
        run();
      }
    });
  }

  function start() {
    return serialize(() => startInternal());
  }
  function stop() {
    return serialize(() => stopInternal());
  }
  function restart(patch) {
    return serialize(() => restartInternal(patch));
  }

  return {
    envFilePath,
    envTemplatePath,
    logPath,
    dbPassword,
    runtimeModelsPath,
    applyModels,
    removeRuntimeModels,
    backendPort,
    healthUrl,
    ensureEnvFile,
    cleanupStale,
    start,
    stop,
    status,
    restart,
    ownsProcess: () => Boolean(child),
    // 同步读阶段：status() 是异步的（要现探），测试与同步节点上取不到
    bootPhase: () => bootPhase,
    probeHealth
  };
}

module.exports = {
  createBackendManager,
  parseEnv,
  upsertEnv,
  ensureJwtSecret,
  connectionOf
};
