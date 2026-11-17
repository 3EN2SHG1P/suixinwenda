/**
 * 文件：desktop/src/preload-window.js
 * 职责：独立子窗口的预加载脚本——暴露 `window.windowBridge`：
 *      1. 窗口自管：取启动信息 / 结果回传 / 关闭最小化最大化 / 图钉 / 自绘缩放；
 *      2. 复用主窗口已有的系统能力（配置、登录态、后端、备份、产物、模型）；
 *      3. 订阅主进程广播（主题、登录态、当前会话、长任务）。
 * 口径：安全三件套（contextIsolation / sandbox / 无 nodeIntegration）与主窗口一致；
 *      不暴露 require / ipcRenderer 原始对象；订阅一律返回取消函数。
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('windowBridge', {
  // 1. 窗口自管
  launch: () => ipcRenderer.invoke('app-window:launch'),
  onPayload: (handler) => subscribe('app-window:payload', handler),
  onReply: (handler) => subscribe('app-window:reply', handler),
  // 子窗口被直接关掉（没点确认/取消）时也广播一次：调用方据此释放挂起的回调
  onWindowClosed: (handler) => subscribe('app-window:closed', handler),
  onCloseBlocked: (handler) => subscribe('app-window:close-blocked', handler),
  sendResult: (data) => ipcRenderer.send('app-window:result', data),
  close: () => ipcRenderer.send('app-window:close'),
  // 能力保留、当前没有 UI 入口：子窗口标题栏不放最小化键（skipTaskbar + 非单例会让窗口失联）。
  // 将来若要恢复，只需在 app-window.html 加回按钮并在这里绑定。
  minimize: () => ipcRenderer.send('app-window:minimize'),
  toggleMaximize: () => ipcRenderer.send('app-window:toggle-maximize'),
  isMaximized: () => ipcRenderer.invoke('app-window:is-maximized'),
  onMaximizedChanged: (handler) => subscribe('app-window:maximized-changed', handler),
  setPinned: (pinned) => ipcRenderer.invoke('app-window:set-pinned', pinned),
  setClosable: (closable) => ipcRenderer.invoke('app-window:set-closable', closable),
  getBounds: () => ipcRenderer.invoke('app-window:bounds'),
  setBounds: (box) => ipcRenderer.send('app-window:set-bounds', box),
  // 从任意窗口再开一个窗口（设置 → 切换存储 / 确认框）
  openWindow: (view, payload) => ipcRenderer.invoke('app-window:open', view, payload),

  // 2. 主进程能力（与主窗口 preload 同源，来源校验已放开到子窗口入口页）
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (patch) => ipcRenderer.invoke('config:write', patch),
  readAuth: () => ipcRenderer.invoke('auth:read'),
  writeAuth: (payload) => ipcRenderer.invoke('auth:write', payload),
  clearAuth: () => ipcRenderer.invoke('auth:clear'),
  backendStatus: () => ipcRenderer.invoke('backend:status'),
  saveDefaults: () => ipcRenderer.invoke('save:defaults'),
  pickDirectory: (title) => ipcRenderer.invoke('path:pick-directory', title),
  revealPath: (target) => ipcRenderer.invoke('path:reveal', target),
  restartBackend: (patch) => ipcRenderer.invoke('backend:restart', patch),
  testStorage: (patch) => ipcRenderer.invoke('storage:test', patch),
  createBackup: (dir, fileName) => ipcRenderer.invoke('backup:create', dir, fileName),
  exportData: (dir, name) => ipcRenderer.invoke('export:create', dir, name),
  purgeStorage: () => ipcRenderer.invoke('storage:purge'),
  restoreStorage: (payload) => ipcRenderer.invoke('storage:restore', payload),
  pickRestoreFile: () => ipcRenderer.invoke('path:pick-file'),
  listArtifacts: () => ipcRenderer.invoke('artifact:list'),
  deleteArtifact: (id) => ipcRenderer.invoke('artifact:delete', id),
  revealArtifact: (id) => ipcRenderer.invoke('artifact:reveal', id),
  relocateArtifact: (id) => ipcRenderer.invoke('artifact:relocate', id),
  forgetArtifact: (id) => ipcRenderer.invoke('artifact:forget', id),
  cleanOldArtifacts: (options) => ipcRenderer.invoke('artifact:clean-old', options),
  listModels: () => ipcRenderer.invoke('models:list'),
  saveModel: (payload) => ipcRenderer.invoke('models:save', payload),
  deleteModel: (id) => ipcRenderer.invoke('models:delete', id),
  setDefaultModel: (id) => ipcRenderer.invoke('models:default', id),
  clearModelKey: (id) => ipcRenderer.invoke('models:clear-key', id),
  pickAttachment: () => ipcRenderer.invoke('file:pick'),
  openAttachment: (options) => ipcRenderer.invoke('attachment:open', options),
  saveAttachment: (options) => ipcRenderer.invoke('attachment:save', options),
  saveMarkdown: (options) => ipcRenderer.invoke('file:save-markdown', options),

  // 3. 主进程广播
  onConfigChanged: (handler) => subscribe('app:config-changed', handler),
  onAuthChanged: (handler) => subscribe('app:auth-changed', handler),
  onToolBusy: (handler) => subscribe('app:tool-busy', handler),
  onArtifactsChanged: (handler) => subscribe('app:artifacts-changed', handler),
  onModelsChanged: (handler) => subscribe('app:models-changed', handler),
  onBackendRestarted: (handler) => subscribe('app:backend-restarted', handler)
});
