/**
 * 文件：desktop/test/backend-manager.test.js
 * 职责：托管模块的纯逻辑与分支——env 解析 / JWT 自愈 / 子进程环境剔除 / 残留甄别 / 就绪判定。
 * 跑法：`cd desktop; npm test`
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  createBackendManager,
  parseEnv,
  upsertEnv,
  ensureJwtSecret,
  connectionOf
} = require('../src/backend-manager.js');

const ENV_TEMPLATE = ['# 测试模板', 'BACKEND_PORT=8010', 'JWT_SECRET=', 'DB_HOST=127.0.0.1', 'DB_PASSWORD=123456'].join(
  '\n'
);

const createdDirs = [];

function tempBackendDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxw-backend-'));
  createdDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.env.example'), `${ENV_TEMPLATE}\n`, 'utf8');
  return dir;
}

// 每个用例都建一个临时 backend 目录：不清理的话跑一次测试就在 %TEMP% 里留十几个垃圾
test.after(() => {
  createdDirs.forEach((dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  createdDirs.length = 0;
});

function fakeApp(userData, isPackaged) {
  return {
    isPackaged: Boolean(isPackaged),
    getPath: (name) => {
      assert.strictEqual(name, 'userData');
      return userData;
    }
  };
}

function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 4321;
  proc.exitCode = null;
  proc.signalCode = null;
  // 真实后端读到 stdin EOF 就退出：让 end() 立刻触发 exit，
  // 否则 stop() 的 2.5 秒优雅窗口会让每条涉及 stop 的用例真等 2.5 秒
  proc.stdin = {
    ended: false,
    end() {
      this.ended = true;
      proc.exitCode = 0;
      setImmediate(() => proc.emit('exit', 0));
    }
  };
  return proc;
}

function makeManager(overrides) {
  const backendDir = overrides.backendDir || tempBackendDir();
  const calls = { spawns: [], kills: [] };
  // 假时钟：sleep 立即返回、时间每次读表 +1s，就绪超时的用例才能毫秒级跑完
  let clock = 0;
  const manager = createBackendManager({
    app: fakeApp(backendDir, overrides.isPackaged),
    backendDir,
    spawn: (cmd, args, opts) => {
      const proc = fakeProc();
      calls.spawns.push({ cmd, args, opts, proc });
      if (overrides.onSpawn) {
        overrides.onSpawn();
      }
      return proc;
    },
    execFile: (file, args, callback) => {
      calls.kills.push({ file, args });
      callback(null);
    },
    fetchImpl: overrides.fetchImpl,
    // 密码加解密：不传时走「不加密」的默认实现，与改造前的行为一致
    encrypt: overrides.encrypt,
    decrypt: overrides.decrypt,
    sleep: async () => {},
    now: () => {
      clock += 1000;
      return clock;
    },
    logger: { warn() {}, error() {} }
  });
  return { manager, calls, backendDir };
}

// 可逆假加密：真实实现是 Electron safeStorage（DPAPI）
const fakeCrypto = {
  encrypt: (text) => `enc:${Buffer.from(text, 'utf8').toString('base64')}`,
  decrypt: (token) => Buffer.from(String(token).slice(4), 'base64').toString('utf8')
};

test('parseEnv 跳过注释、去引号、取不到返回空串', () => {
  const text = '# DB_HOST=1.2.3.4\nDB_HOST="127.0.0.1"  \nDB_PORT=3306\n';
  assert.strictEqual(parseEnv(text, 'DB_HOST'), '127.0.0.1');
  assert.strictEqual(parseEnv(text, 'DB_PORT'), '3306');
  assert.strictEqual(parseEnv(text, 'DB_USER'), '');
});

test('upsertEnv 替换已有键、追加缺失键，其它行原样保留', () => {
  const replaced = upsertEnv('JWT_SECRET=\nDB_PORT=3306\n', 'JWT_SECRET', 'abc');
  assert.match(replaced, /^JWT_SECRET=abc$/m);
  assert.match(replaced, /^DB_PORT=3306$/m);
  const appended = upsertEnv('DB_PORT=3306\n', 'DB_BACKEND', 'sqlite');
  assert.match(appended, /^DB_BACKEND=sqlite$/m);
});

test('JWT_SECRET 为空时自动生成且长度达标，已有合法值不改写', () => {
  const filled = ensureJwtSecret('JWT_SECRET=\n');
  assert.strictEqual(filled.changed, true);
  assert.ok(parseEnv(filled.text, 'JWT_SECRET').length >= 32);

  const kept = ensureJwtSecret(`JWT_SECRET=${'x'.repeat(40)}\n`);
  assert.strictEqual(kept.changed, false);
  assert.strictEqual(parseEnv(kept.text, 'JWT_SECRET'), 'x'.repeat(40));
});

test('JWT_SECRET 非空但过短时也不覆盖：静默换值会让所有人被登出', () => {
  const kept = ensureJwtSecret('JWT_SECRET=short\n');
  assert.strictEqual(kept.changed, false);
  assert.strictEqual(parseEnv(kept.text, 'JWT_SECRET'), 'short');
});

test('ensureEnvFile 在缺失时从模板生成并补 JWT_SECRET', () => {
  const { manager, backendDir } = makeManager({});
  const file = manager.ensureEnvFile();
  assert.strictEqual(file, path.join(backendDir, '.env'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(parseEnv(text, 'JWT_SECRET').length >= 32);
  assert.strictEqual(parseEnv(text, 'BACKEND_PORT'), '8010');
});

test('子进程环境剔除 DB_*，并注入托管标记与 env 文件路径', async () => {
  const { manager, calls, backendDir } = makeManager({
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) })
  });
  process.env.DB_HOST = '10.0.0.9';
  try {
    await manager.start();
  } finally {
    delete process.env.DB_HOST;
  }
  const env = calls.spawns[0].opts.env;
  assert.strictEqual(env.SUIXINWENDA_MANAGED, '1');
  assert.strictEqual(env.SUIXINWENDA_ENV_FILE, path.join(backendDir, '.env'));
  assert.strictEqual(env.DB_HOST, undefined, '外层 shell 的 DB_HOST 不能漏给后端');
  assert.strictEqual(calls.spawns[0].opts.stdio[0], 'pipe', 'stdin 必须是 pipe，后端哨兵靠它读 EOF');
});

test('healthUrl 跟着 .env 的 BACKEND_PORT 走', () => {
  const { manager, backendDir } = makeManager({});
  fs.writeFileSync(path.join(backendDir, '.env'), `JWT_SECRET=${'x'.repeat(40)}\nBACKEND_PORT=8123\n`, 'utf8');
  assert.strictEqual(manager.healthUrl(), 'http://127.0.0.1:8123/api/v1/health');
});

test('healthUrl：.env 监听通配地址时仍按回环探活', () => {
  const { manager, backendDir } = makeManager({});
  fs.writeFileSync(
    path.join(backendDir, '.env'),
    `JWT_SECRET=${'x'.repeat(40)}\nBACKEND_PORT=8010\nBACKEND_HOST=0.0.0.0\n`,
    'utf8'
  );
  // 0.0.0.0 是本机不可直达的通配地址，直接拼进 URL 会得到永远连不上的健康检查
  assert.strictEqual(manager.healthUrl(), 'http://127.0.0.1:8010/api/v1/health');
});

test('外层 shell 的 BACKEND_HOST 不会漏给后端，托管一律回环', async () => {
  const { manager, calls } = makeManager({
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) })
  });
  process.env.BACKEND_HOST = '0.0.0.0';
  try {
    await manager.start();
  } finally {
    delete process.env.BACKEND_HOST;
  }
  const env = calls.spawns[0].opts.env;
  assert.strictEqual(env.BACKEND_HOST, '127.0.0.1', '托管模式必须锁死回环，不得继承外层的通配地址');
});

test('cleanupStale：端口没人听 → none', async () => {
  const { manager } = makeManager({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.deepStrictEqual(await manager.cleanupStale(), { action: 'none' });
});

test('cleanupStale：响应不是本项目 → 中文报错，不误杀', async () => {
  const { manager, calls } = makeManager({
    fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'world' }) })
  });
  await assert.rejects(() => manager.cleanupStale(), /被其它程序占用/);
  assert.strictEqual(calls.kills.length, 0);
});

test('cleanupStale：托管残留 → 杀掉；外部启动 → 复用不杀', async () => {
  const managed = makeManager({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 0, message: '服务正常', data: { managed: true, pid: 999 } })
    })
  });
  const killed = await managed.manager.cleanupStale();
  assert.strictEqual(killed.action, 'killed');
  assert.deepStrictEqual(managed.calls.kills[0].args, ['/PID', '999', '/T', '/F']);

  const external = makeManager({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 0, message: '服务正常', data: { managed: false, pid: 111 } })
    })
  });
  assert.deepStrictEqual(await external.manager.cleanupStale(), { action: 'reused' });
  assert.strictEqual(external.calls.kills.length, 0);
  assert.strictEqual(external.manager.ownsProcess(), false, '外部后端不算自己起的');
});

test('start：健康始终不 ok 时抛错并清理进程', async () => {
  const { manager, calls } = makeManager({
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 1 }) })
  });
  await assert.rejects(() => manager.start(), /没有就绪|进程已退出/);
  assert.strictEqual(calls.spawns.length, 1);
});

test('spawn 异步报错（没装 uv）时 start 拒绝，不把 error 事件漏成崩溃', async () => {
  const backendDir = tempBackendDir();
  const manager = createBackendManager({
    app: fakeApp(backendDir),
    backendDir,
    spawn: () => {
      const proc = fakeProc();
      // 真实 spawn 的失败是异步事件；用 setImmediate 模拟，sleep 也让出 macrotask
      setImmediate(() => proc.emit('error', new Error('spawn uv ENOENT')));
      return proc;
    },
    execFile: (file, args, callback) => callback(null),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    now: (() => {
      let clock = 0;
      return () => {
        clock += 1000;
        return clock;
      };
    })(),
    logger: { warn() {}, error() {} }
  });
  await assert.rejects(() => manager.start(), /后端无法启动（spawn uv ENOENT）/);
});

test('status 每次现探：后端中途挂掉后不再返回陈旧的 ok', async () => {
  let healthy = true;
  const { manager } = makeManager({
    fetchImpl: async () => {
      if (!healthy) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) };
    }
  });
  await manager.start();
  assert.strictEqual((await manager.status()).ok, true);
  healthy = false;
  const after = await manager.status();
  assert.strictEqual(after.ok, false, '探不到就必须报未就绪，不能拿启动时的快照骗人');
});

test('restart：写入新后端并重启，成功返回 ok', async () => {
  // restart 在拉新进程前会先确认端口真的空了（ensurePortReleased）：
  // 第一个 spawn 之前健康检查必须探不到，否则它会判定「旧进程还活着」而拒绝切换
  let listening = false;
  const { manager, calls, backendDir } = makeManager({
    onSpawn: () => {
      listening = true;
    },
    fetchImpl: async () => {
      if (!listening) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: true, json: async () => ({ code: 0, message: '服务正常', data: { managed: true, pid: 1 } }) };
    }
  });
  const result = await manager.restart({ DB_BACKEND: 'sqlite' });

  assert.deepStrictEqual(result, { ok: true });
  const env = fs.readFileSync(path.join(backendDir, '.env'), 'utf8');
  assert.match(env, /^DB_BACKEND=sqlite$/m);
  assert.strictEqual(calls.spawns.length, 1, '重启后应重新拉起一次后端');
});

test('restart：旧进程停不下来时拒绝切换（防止报成功但跑的还是旧配置）', async () => {
  const { manager } = makeManager({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 0, message: '服务正常', data: { managed: true, pid: 1 } })
    })
  });
  const result = await manager.restart({ DB_BACKEND: 'sqlite' });

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /端口仍被占用/);
});

test('restart：外部启动的后端不许由应用代重启（env 写了进程没换 = 假成功）', async () => {
  const { manager } = makeManager({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 0, message: '服务正常', data: { managed: false, pid: 9 } })
    })
  });
  // 模拟应用启动时发现一个健康但非托管的后端：只复用、不杀
  await manager.cleanupStale();

  const result = await manager.restart({ DB_BACKEND: 'sqlite' });

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /外部启动/);
});

test('restart：启动失败时回滚配置并报「已回到原存储」', async () => {
  let healthy = true;
  const { manager, backendDir } = makeManager({
    fetchImpl: async () => {
      if (!healthy) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) };
    }
  });
  // 先有一份可用的配置
  fs.writeFileSync(path.join(backendDir, '.env'), 'JWT_SECRET=' + 'x'.repeat(40) + '\n', 'utf8');
  await manager.start();
  healthy = false;

  const result = await manager.restart({ DB_BACKEND: 'sqlite' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /切换失败，已回到原存储/);
  const env = fs.readFileSync(path.join(backendDir, '.env'), 'utf8');
  assert.ok(!/^DB_BACKEND=/m.test(env), '失败后必须把配置恢复成切换前的样子');
});

test('bootPhase：spawning → waiting → ready，stop 后回 idle', async () => {
  const phases = [];
  const holder = {};
  const backendDir = tempBackendDir();
  const manager = createBackendManager({
    app: fakeApp(backendDir),
    backendDir,
    spawn: () => {
      // spawn 是同步调用的：此刻必须已经是 spawning，界面才有「正在启动」可显示
      phases.push(holder.manager.bootPhase());
      return fakeProc();
    },
    execFile: (file, args, callback) => callback(null),
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) }),
    sleep: async () => {},
    now: (() => {
      let clock = 0;
      return () => {
        clock += 1000;
        return clock;
      };
    })(),
    logger: { warn() {}, error() {} }
  });
  holder.manager = manager;

  assert.strictEqual(manager.bootPhase(), 'idle', '没启动时必须是 idle');
  const starting = manager.start(); // 不 await：先看同步阶段
  phases.push(manager.bootPhase());
  const status = await starting;
  phases.push(status.bootPhase);

  assert.deepStrictEqual(phases, ['spawning', 'waiting', 'ready']);

  await manager.stop();
  assert.strictEqual(manager.bootPhase(), 'idle', 'stop 之后必须回 idle');
});

test('bootPhase：启动失败置 failed', async () => {
  const { manager } = makeManager({
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 1 }) })
  });
  await assert.rejects(() => manager.start());
  assert.strictEqual(manager.bootPhase(), 'failed');
});

test('bootPhase：进程自己退出时退回 idle（小窗不会一直停在等待）', async () => {
  const { manager, calls } = makeManager({
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) })
  });
  await manager.start();
  assert.strictEqual(manager.bootPhase(), 'ready');
  // 崩溃退出：exit 事件不是 stop() 触发的
  calls.spawns[0].proc.exitCode = 1;
  calls.spawns[0].proc.emit('exit', 1);
  assert.strictEqual(manager.bootPhase(), 'idle');
});

test('打包态 ensureEnvFile 把明文密码迁移成密文，dbPassword 仍能解出明文', () => {
  const { manager } = makeManager({
    isPackaged: true,
    encrypt: fakeCrypto.encrypt,
    decrypt: fakeCrypto.decrypt
  });
  // 打包态的配置文件是 userData/config.env（不是 backend/.env）
  const file = manager.envFilePath();
  fs.writeFileSync(file, `JWT_SECRET=${'x'.repeat(40)}\nDB_PASSWORD=123456\n`, 'utf8');

  manager.ensureEnvFile();

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/^DB_PASSWORD=/m.test(text), '迁移后配置文件里不许再有明文行');
  assert.match(text, /^DB_PASSWORD_ENC=enc:/m);
  assert.strictEqual(manager.dbPassword(), '123456', '后端与工具仍然要拿到明文');
});

test('开发态不迁移明文：backend/.env 同时是手动 uv 启动的配置，迁了就等于把手动路径堵死', () => {
  const { manager, backendDir } = makeManager({
    encrypt: fakeCrypto.encrypt,
    decrypt: fakeCrypto.decrypt
  });
  const file = path.join(backendDir, '.env');
  fs.writeFileSync(file, `JWT_SECRET=${'x'.repeat(40)}\nDB_PASSWORD=123456\n`, 'utf8');

  manager.ensureEnvFile();

  assert.match(fs.readFileSync(file, 'utf8'), /^DB_PASSWORD=123456$/m);
  assert.strictEqual(manager.dbPassword(), '123456');
});

test('迁移是幂等的：没有明文可迁时不动文件内容', () => {
  const { manager } = makeManager({
    isPackaged: true,
    encrypt: fakeCrypto.encrypt,
    decrypt: fakeCrypto.decrypt
  });
  const file = manager.envFilePath();
  fs.writeFileSync(file, `JWT_SECRET=${'x'.repeat(40)}\nDB_BACKEND=sqlite\n`, 'utf8');
  manager.ensureEnvFile(); // 第一次：可能补 JWT / 密文迁移 / 钉 DATA_DIR
  const normalized = fs.readFileSync(file, 'utf8');
  manager.ensureEnvFile(); // 第二次起：什么都不该再变
  assert.strictEqual(fs.readFileSync(file, 'utf8'), normalized);
});

test('打包态 ensureEnvFile 把 DATA_DIR 钉到 userData/data（服务与工具必须同一个库）', () => {
  const { manager, backendDir } = makeManager({ isPackaged: true });
  const file = manager.envFilePath();
  fs.writeFileSync(file, `JWT_SECRET=${'x'.repeat(40)}\n`, 'utf8');

  manager.ensureEnvFile();

  const text = fs.readFileSync(file, 'utf8');
  // 与 main.js 里 toolEnv 的 dataDir 同口径：userData/data
  assert.strictEqual(parseEnv(text, 'DATA_DIR'), path.join(backendDir, 'data'));
});

test('开发态不钉 DATA_DIR：backend/.env 是手动 uv 启动的配置，桌面端不许加私货', () => {
  const { manager, backendDir } = makeManager({});
  const file = path.join(backendDir, '.env');
  fs.writeFileSync(file, `JWT_SECRET=${'x'.repeat(40)}\n`, 'utf8');

  manager.ensureEnvFile();

  assert.ok(!/^DATA_DIR=/m.test(fs.readFileSync(file, 'utf8')), '开发态配置文件里不该出现 DATA_DIR');
});

test('restart 写密码时落盘是密文，子进程环境拿到明文', async () => {
  let listening = false;
  const { manager, calls, backendDir } = makeManager({
    encrypt: fakeCrypto.encrypt,
    decrypt: fakeCrypto.decrypt,
    onSpawn: () => {
      listening = true;
    },
    fetchImpl: async () => {
      if (!listening) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) };
    }
  });

  const result = await manager.restart({
    DB_BACKEND: 'mysql',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_USER: 'root',
    DB_PASSWORD: 'p@ss-123456',
    DB_NAME: 'suixinwenda'
  });

  assert.strictEqual(result.ok, true);
  const text = fs.readFileSync(path.join(backendDir, '.env'), 'utf8');
  assert.ok(!text.includes('p@ss-123456'), '配置文件里 grep 不到明文密码');
  assert.match(text, /^DB_PASSWORD_ENC=enc:/m);
  assert.strictEqual(calls.spawns[0].opts.env.DB_PASSWORD, 'p@ss-123456', '托管启动要注入明文');
});

test('connectionOf 只挑白名单键：健康检查里就算带了密码也不会顺着 IPC 漏出去', () => {
  const view = connectionOf({
    backend: 'mysql',
    connection: {
      host: '127.0.0.1',
      port: '3306',
      user: 'root',
      name: 'suixinwenda',
      password: 'p@ss',
      remote: true,
      allow_remote: true,
      ssl: true,
      ssl_ca: 'C:\\certs\\ca.pem'
    }
  });
  assert.deepStrictEqual(view, {
    host: '127.0.0.1',
    port: '3306',
    user: 'root',
    name: 'suixinwenda',
    remote: true,
    allowRemote: true,
    ssl: true,
    sslCa: 'C:\\certs\\ca.pem'
  });
  assert.strictEqual(JSON.stringify(view).includes('p@ss'), false);
  assert.strictEqual(connectionOf(null), null);
  assert.strictEqual(connectionOf({ backend: 'sqlite' }), null);
});

test('status 带回连接回显，且响应里不含密码', async () => {
  const { manager } = makeManager({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        message: '服务正常',
        data: {
          db: {
            backend: 'mysql',
            location: '10.0.0.9:3306/suixinwenda',
            connection: { host: '10.0.0.9', port: '3306', user: 'app', name: 'suixinwenda' }
          }
        }
      })
    })
  });
  const status = await manager.status();
  assert.deepStrictEqual(status.connection, {
    host: '10.0.0.9',
    port: '3306',
    user: 'app',
    name: 'suixinwenda',
    remote: false,
    allowRemote: false,
    ssl: false,
    sslCa: ''
  });
  assert.deepStrictEqual(Object.keys(status).includes('password'), false);
});

test('stop：taskkill 后仍未退出必须报错并保留 child（不能假装已停止）', async () => {
  const proc = new EventEmitter();
  proc.pid = 9876;
  proc.exitCode = null;
  proc.stdin = { end() {} };
  // 进程永不退出：模拟 taskkill 被权限/杀软拦住（makeManager 的 fakeProc 会响应 stdin EOF）
  const stuck = createBackendManager({
    app: fakeApp(tempBackendDir()),
    backendDir: tempBackendDir(),
    spawn: () => proc,
    execFile: (file, args, callback) => callback(null),
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, message: '服务正常', data: {} }) }),
    sleep: async () => {},
    now: (() => {
      let clock = 0;
      return () => {
        clock += 1000;
        return clock;
      };
    })(),
    logger: { warn() {}, error() {} }
  });
  await stuck.start();
  assert.strictEqual(stuck.ownsProcess(), true);
  await assert.rejects(() => stuck.stop(), /无法停止后端进程/);
  assert.strictEqual(stuck.ownsProcess(), true, '失败后必须保留 child，让上层知道端口仍被占');
});

test('start：健康 ok 后 status 反映运行态，stop 关 stdin 后置空', async () => {
  const { manager, calls } = makeManager({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        message: '服务正常',
        data: { managed: true, pid: 1, db: { backend: 'mysql', location: '127.0.0.1:3306/suixinwenda' } }
      })
    })
  });
  const status = await manager.start();
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.backend, 'mysql');
  assert.strictEqual(manager.ownsProcess(), true);

  const stopping = manager.stop();
  calls.spawns[0].proc.exitCode = 0;
  calls.spawns[0].proc.emit('exit', 0);
  await stopping;
  assert.strictEqual(manager.ownsProcess(), false);
  assert.strictEqual(calls.spawns[0].proc.stdin.ended, true);
});
