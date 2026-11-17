/**
 * 文件：desktop/src/splash-preload.js
 * 职责：启动 / 退出小窗的预加载脚本——只暴露一条「订阅启动阶段」的通道。
 *
 * 为什么不复用 preload-main.js：小窗只显示 logo 和一行字，把 desktopBridge 的全套能力
 * （窗口控制、配置读写、登录态、选文件、导出、产物管理）暴露给它是白白扩大攻击面。
 * 安全三件套（contextIsolation / sandbox / 无 nodeIntegration）与 preload-main.js 同一口径。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashBridge', {
  // 返回取消函数，与 preload-main.js 的订阅口径一致（重复注册会让 handler 累积）
  onSplashStatus: (handler) => {
    const listener = (event, payload) => handler(payload);
    ipcRenderer.on('splash:status', listener);
    return () => ipcRenderer.removeListener('splash:status', listener);
  }
});
