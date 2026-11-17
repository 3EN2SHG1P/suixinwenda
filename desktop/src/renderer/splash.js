/**
 * 文件：desktop/src/renderer/splash.js
 * 职责：启动 / 退出小窗的文案推进——只按主进程推来的阶段改字，页面自己
 *      只在「1.5 秒还没进入下一阶段」时补一句安抚文案，不编造任何中间态。
 * 口径：本页拿不到 desktopBridge，只认 splashBridge.onSplashStatus（见 splash-preload.js）。
 */

// 后端 import 就要 2.5 秒：1.5 秒还没进入下一阶段，先给一句安抚，别让用户以为卡死
const SLOW_HINT_MS = 1500;

let statusEl = document.getElementById('splash-status');
const footEl = document.getElementById('splash-foot');
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'exit' ? 'exit' : 'boot';

// 主题由主进程随窗口底色一起给：页面自己猜会出现「窗口深、页面浅」的割裂感
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.body.dataset.mode = mode;

let phase = 'spawning';

/**
 * 改状态行。
 *
 * 失败时**新建**一个节点替换旧节点：在同一次更新里把 aria-live 从 polite 改成 assertive，
 * 多数读屏器不会重读新内容；换节点最稳（role=alert 在插入时就会播报）。
 * 也顺带把红色与换行规则挂上去（样式在 splash.css 里）。
 */
function render(nextPhase, message) {
  phase = nextPhase;
  if (nextPhase === 'failed') {
    const next = document.createElement('p');
    next.id = 'splash-status';
    next.className = 'splash-status is-error';
    next.setAttribute('role', 'alert');
    next.textContent = message;
    statusEl.replaceWith(next);
    statusEl = next;
    return;
  }
  statusEl.textContent = message;
}

if (mode === 'exit') {
  // 退出阶段只有一个状态：停完后端主进程直接 exit(0)，没有中间态可报
  render('exit', '正在退出…');
  footEl.textContent = '正在关闭本地服务';
} else {
  render('spawning', '正在启动本地服务…');
  window.setTimeout(() => {
    if (phase === 'spawning') {
      render('spawning', '首次启动稍慢，请稍候…');
    }
  }, SLOW_HINT_MS);
  if (window.splashBridge) {
    window.splashBridge.onSplashStatus((payload) => {
      if (!payload || !payload.phase) {
        return;
      }
      render(payload.phase, payload.message || statusEl.textContent);
    });
  }
}
