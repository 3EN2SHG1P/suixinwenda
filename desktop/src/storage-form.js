/**
 * 文件：desktop/src/storage-form.js
 * 职责：存储切换表单的纯校验逻辑——白名单键、本机/远程判定、CA 证书检查、切换 patch 组装。
 *
 * 为什么从 main.js 抽出来：这三件事决定了「页面能不能把配置写歪」和「切换会不会被后端拒绝」，
 * 而 main.js 需要 electron 才能加载、没法单测。抽成纯函数后，规则可以逐条压住。
 *
 * 三个「本机 host」名单必须与后端 core/db_info.py 的 LOCAL_HOSTS 完全一致：
 * 这边说本机、那边说远程时，切换必然失败，且提示互相对不上。
 */
const DB_LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// 存储配置白名单：切换存储是渲染进程唯一能改 env 的口子，只认这几个键。
// 放开成「任意键」等于把整份配置文件（含 JWT_SECRET、API Key）交给页面
const STORAGE_KEYS = [
  'DB_BACKEND',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  // 远程库放行开关与 CA 证书：都属于「连接这套 MySQL 的参数」，必须能一起写
  'DB_ALLOW_REMOTE',
  'DB_SSL_CA'
];

/**
 * 校验 MySQL 连接表单（主进程是最后一道，渲染进程的校验只为当场说清楚）。
 *
 * 密码必须非空：tools/storage_test.py 允许空密码（本机 root 空密码能测通），
 * 但 core/database.py 的 database_url() 对 DB_PASSWORD 走 require，
 * 空值会让后端启动直接报「缺少配置项」——表现就是「测试通过、切换必失败」。
 *
 * options.existsSync 由调用方注入：单测里不需要真的造证书文件。
 */
function sanitizeStorageForm(patch, options) {
  const opts = options || {};
  const exists = typeof opts.existsSync === 'function' ? opts.existsSync : () => true;
  const source = patch && typeof patch === 'object' ? patch : {};
  const value = {};
  STORAGE_KEYS.forEach((key) => {
    value[key] = typeof source[key] === 'string' ? source[key] : '';
  });
  const host = value.DB_HOST.trim();
  const port = value.DB_PORT.trim();
  const user = value.DB_USER.trim();
  // 密码不去空格：那是用户口令的一部分，只在判空时用 trim
  const password = value.DB_PASSWORD;
  const name = value.DB_NAME.trim();
  if (!host || /\s/.test(host)) {
    return { error: '主机不能为空，也不能包含空白字符' };
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return { error: '端口必须是 1-65535 之间的整数' };
  }
  if (!user) {
    return { error: '用户名不能为空' };
  }
  if (!password.trim()) {
    return { error: '密码不能为空：后端的数据库连接必须带密码（本机 MySQL 是空密码时请先设一个）' };
  }
  if (!name) {
    return { error: '库名不能为空' };
  }
  // 允许远程是「明确同意聊天记录离开本机」：只认 '1'，其余一律当没同意。
  // 远程地址却没勾选时必须当场拦住——放过去的话，写进配置后后端会拒绝启动，
  // 用户只会看到「后端进程已退出」，根本联想不到是这里少勾了一个框
  const allowRemote = String(source.DB_ALLOW_REMOTE || '').trim() === '1' ? '1' : '';
  const remote = !DB_LOCAL_HOSTS.includes(host.toLowerCase());
  if (remote && !allowRemote) {
    return { error: '这是远程地址：请先勾选「允许连接远程（聊天记录会离开本机）」' };
  }
  // CA 证书：可空；填了必须是能读到的文件。含换行会把 .env 写坏，必须挡掉
  const sslCa = String(source.DB_SSL_CA || '').trim();
  if (sslCa) {
    if (/[\r\n]/.test(sslCa)) {
      return { error: 'CA 证书路径不合法' };
    }
    if (!exists(sslCa)) {
      return { error: 'CA 证书文件不存在：请重新选择 .pem 文件，或清空该项' };
    }
  }
  return {
    values: {
      DB_HOST: host,
      DB_PORT: port,
      DB_USER: user,
      DB_PASSWORD: password,
      DB_NAME: name,
      // 本机地址一律清空放行开关：留着它等于以后换远程时默认放行
      DB_ALLOW_REMOTE: remote ? allowRemote : '',
      DB_SSL_CA: sslCa
    }
  };
}

/** 切换存储的 patch：切回 SQLite 只需 DB_BACKEND，切到 MySQL 必须带齐连接参数。 */
function sanitizeRestartPatch(patch, options) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const backend = String(source.DB_BACKEND || '');
  if (backend !== 'sqlite' && backend !== 'mysql') {
    return { error: '不支持的存储类型' };
  }
  if (backend === 'sqlite') {
    // 切回本地文件库时把「允许远程」与 CA 一起清掉：它们只对当前这套 MySQL 配置有意义，
    // 留着等于以后再填一个远程地址时默认放行，安全提示形同虚设
    return { patch: { DB_BACKEND: backend, DB_ALLOW_REMOTE: '', DB_SSL_CA: '' } };
  }
  const clean = sanitizeStorageForm(source, options);
  if (clean.error) {
    return clean;
  }
  return { patch: { DB_BACKEND: backend, ...clean.values } };
}

/** 探测用的环境变量：五个连接参数 + 可选的 CA，全部走 env（命令行会被进程列表看光）。 */
function probeEnv(values) {
  const source = values || {};
  return {
    SUIXINWENDA_PROBE_HOST: source.DB_HOST || '',
    SUIXINWENDA_PROBE_PORT: source.DB_PORT || '',
    SUIXINWENDA_PROBE_USER: source.DB_USER || '',
    SUIXINWENDA_PROBE_PASSWORD: source.DB_PASSWORD || '',
    SUIXINWENDA_PROBE_NAME: source.DB_NAME || '',
    // 有 CA 就用 TLS 探测：否则「测试连接通过、切换后 SSL 失败」这类分叉永远测不出来
    SUIXINWENDA_PROBE_SSL_CA: source.DB_SSL_CA || ''
  };
}

module.exports = {
  DB_LOCAL_HOSTS,
  STORAGE_KEYS,
  sanitizeStorageForm,
  sanitizeRestartPatch,
  probeEnv
};
