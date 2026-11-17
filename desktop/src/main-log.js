/**
 * 文件：desktop/src/main-log.js
 * 职责：主进程文件日志——把启动 / 退出 / 后端三类事件追加到 `<userData>/logs/main.log`。
 * 口径：打包版没有控制台，用户报「卡在正在启动」时手上零证据，所以要留一份磁盘日志；
 *      但日志是附属品，任何写入 / 轮转失败都不许影响启动与退出，失败只报一次然后静默。
 */

const fs = require('fs');
const path = require('path');

// 单行文本上限：后端 stderr 常常是整段堆栈，同步落盘会顶住主线程，也没人看得完
const MAX_TEXT_CHARS = 500;

/**
 * 本地时间 `YYYY-MM-DD HH:mm:ss`。
 *
 * 不用 toISOString：那是 UTC，中国时区下与用户看到的时间差 8 小时，
 * 用户拿日志对时间会立刻对不上。
 */
function localStamp(at) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 压掉换行并截断：一条日志必须是一行，长度可控。 */
function oneLine(text) {
  const flat = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ');
  return flat.length > MAX_TEXT_CHARS ? flat.slice(0, MAX_TEXT_CHARS) : flat;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    return 0;
  }
}

/**
 * 建一份日志写入器。
 *
 * - `path()` 惰性求值并 memoize：模块顶层调 app.getPath('userData') 时 app 可能还没 ready，
 *   冒烟模式更要等 setPath('userData') 之后目录才定得下来。
 * - 冒烟只走 console：`npm run smoke` 的结论靠 stdout 判读，落盘既无意义又会漏进临时目录。
 */
function createLogFile({ app, isSmoke, maxBytes = 5 * 1024 * 1024, now = Date.now } = {}) {
  let cachedPath = '';
  // 内存字节计数：每写一条都 statSync 一次太浪费；只在首次写失败时用磁盘大小校正一次
  let bytes = 0;
  // 两个失败各用一个 flag：一次轮转失败（EBUSY / 杀软占用）不该让之后的写失败被一起吞掉
  let writeReported = false;
  let rotateReported = false;

  function pathOf() {
    if (!cachedPath) {
      cachedPath = path.join(app.getPath('userData'), 'logs', 'main.log');
      // 上个进程留下的日志也要计入上限：计数从 0 起时 maxBytes 只约束「本次进程增量」，
      // 老日志已经很大也不会触发轮转，跑几个月就变成几百 MB
      bytes = fileSize(cachedPath);
    }
    return cachedPath;
  }

  function rotate(file) {
    try {
      // 只留一份历史：日志用来定位最近一次问题，堆一整个目录反而没人看
      fs.renameSync(file, `${file}.1`);
      bytes = 0;
    } catch (error) {
      // 多实例 / 杀软占着文件时 rename 会失败：继续往原文件追加，宁可变大也不能断在这一刻
      if (!rotateReported) {
        rotateReported = true;
        console.error('[日志] 轮转失败，继续追加到原文件', error);
      }
    }
  }

  function appendLine(file, line, size) {
    if (bytes > 0 && bytes + size > maxBytes) {
      rotate(file);
    }
    fs.appendFileSync(file, line, 'utf8');
    bytes += size;
  }

  function log(level, text) {
    if (isSmoke) {
      return;
    }
    const line = `${localStamp(now())} [${level}] ${oneLine(text)}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    const file = pathOf();
    try {
      appendLine(file, line, size);
    } catch (error) {
      // 首次运行时 logs/ 还不存在，appendFileSync 会 ENOENT：
      // 补建目录、用磁盘上的真实大小校正一次计数（上个进程留下的日志也要计入上限），再重试一次
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        bytes = fileSize(file);
        appendLine(file, line, size);
      } catch (retryError) {
        if (!writeReported) {
          writeReported = true;
          console.error('[日志] 写入失败，后续只走控制台', retryError);
        }
      }
    }
  }

  return { path: pathOf, log };
}

module.exports = { createLogFile };
