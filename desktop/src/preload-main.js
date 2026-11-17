/**
 * 文件：desktop/src/preload-main.js
 * 职责：主窗口预加载脚本——在隔离上下文里向渲染进程暴露唯一的 `desktopBridge`，
 *      只给出窗口控制、配置读写、系统能力、独立子窗口四类方法，不暴露 require / ipcRenderer 等原始对象。
 * 口径：安全三件套（contextIsolation / sandbox / 无 nodeIntegration）不动；暴露面只增不减。
 * 订阅类方法统一返回取消函数，避免重复注册后 handler 累积（改一次调用就多一个监听的坑）。
 *
 * 为什么单独成文件：主窗口与子窗口的 preload 是两套暴露面（子窗口不需要 window:*，主窗口不需要缩放），
 * 合并会把「谁能调什么」搅在一起，也容易在两份之间漏方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 注册主进程事件订阅，返回取消订阅函数（页面卸载或重复绑定时调用）。
 */
function subscribe(channel, handler) {
  const listener = (event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopBridge', {
  // 1. 窗口控制（无边框窗口的按钮与最大化状态）
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChanged: (handler) => subscribe('window:maximized-changed', handler),
  // 2. 配置读写（接口地址与主题；主进程只收白名单键）
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (patch) => ipcRenderer.invoke('config:write', patch),
  // 2b. 登录态（令牌由主进程 safeStorage 加密落盘，页面只拿得到值）
  readAuth: () => ipcRenderer.invoke('auth:read'),
  writeAuth: (payload) => ipcRenderer.invoke('auth:write', payload),
  clearAuth: () => ipcRenderer.invoke('auth:clear'),
  // 2c. 后端进程状态（只读：托管动作一律留在主进程）
  backendStatus: () => ipcRenderer.invoke('backend:status'),
  // 2c2. 后端就绪通知：主窗口往往比后端先加载完，没有这条事件就要白等一轮离线轮询
  onBackendReady: (handler) => subscribe('backend:ready', handler),
  // 2d. 备份 / 导出：位置与名称由页面窗口给出，主进程负责执行
  createBackup: (dir, fileName) => ipcRenderer.invoke('backup:create', dir, fileName),
  saveDefaults: () => ipcRenderer.invoke('save:defaults'),
  pickDirectory: (title) => ipcRenderer.invoke('path:pick-directory', title),
  revealPath: (target) => ipcRenderer.invoke('path:reveal', target),
  // 2e. 切换存储（只允许 DB_BACKEND + 五个 DB_*；重启后端由主进程负责）
  restartBackend: (patch) => ipcRenderer.invoke('backend:restart', patch),
  // 2e2. 测试 MySQL 连接参数（值走子进程环境变量，口令不进命令行）
  testStorage: (patch) => ipcRenderer.invoke('storage:test', patch),
  // 2f. 导出结构化数据（JSONL + manifest，用于换库/归档）
  exportData: (dir, name) => ipcRenderer.invoke('export:create', dir, name),
  // 2f2. 一键清除当前存储的全部会话数据（不可逆，页面需二次确认）
  purgeStorage: () => ipcRenderer.invoke('storage:purge'),
  // 2f3. 从备份 zip 或导出目录恢复；选包对话框只返回路径（校验在主进程）
  restoreStorage: (payload) => ipcRenderer.invoke('storage:restore', payload),
  pickRestoreFile: () => ipcRenderer.invoke('path:pick-file'),
  // 2g. 产物管理（备份 / 导出的列举、删除、定位、重新定位、移除记录）
  listArtifacts: () => ipcRenderer.invoke('artifact:list'),
  deleteArtifact: (id) => ipcRenderer.invoke('artifact:delete', id),
  revealArtifact: (id) => ipcRenderer.invoke('artifact:reveal', id),
  relocateArtifact: (id) => ipcRenderer.invoke('artifact:relocate', id),
  forgetArtifact: (id) => ipcRenderer.invoke('artifact:forget', id),
  // 清理 N 天前的产物：{ days, confirm } —— 不传 confirm 只返回待删清单
  cleanOldArtifacts: (options) => ipcRenderer.invoke('artifact:clean-old', options),
  // 2h. 模型配置：每个模型自带 Base URL 与 Key（回给页面的数据永不含 Key）
  listModels: () => ipcRenderer.invoke('models:list'),
  saveModel: (payload) => ipcRenderer.invoke('models:save', payload),
  deleteModel: (id) => ipcRenderer.invoke('models:delete', id),
  setDefaultModel: (id) => ipcRenderer.invoke('models:default', id),
  clearModelKey: (id) => ipcRenderer.invoke('models:clear-key', id),
  // 3. 系统弹窗能力：选附件（读成 base64 只经本通道给渲染进程）、导出保存
  pickAttachment: () => ipcRenderer.invoke('file:pick'),
  saveMarkdown: (options) => ipcRenderer.invoke('file:save-markdown', options),
  // 3b. 附件预览：交系统程序打开 / 另存到本地（主进程落临时文件，渲染进程不碰路径）
  openAttachment: (options) => ipcRenderer.invoke('attachment:open', options),
  saveAttachment: (options) => ipcRenderer.invoke('attachment:save', options),
  // 4. 原生菜单与快捷键下发的动作（new-chat / export-chat / toggle-theme / open-settings）
  onMenuAction: (handler) => subscribe('menu:action', handler),

  // 5. 独立子窗口：打开 / 静默换内容 / 入口清单 / 回传结果 / 答复 / 关窗通知
  openWindow: (view, payload) => ipcRenderer.invoke('app-window:open', view, payload),
  pushWindow: (view, payload) => ipcRenderer.invoke('app-window:push', view, payload),
  windowEntries: () => ipcRenderer.invoke('app-window:entries'),
  replyWindow: (view, data) => ipcRenderer.send('app-window:reply', view, data),
  onWindowResult: (handler) => subscribe('app-window:result', handler),
  onWindowReply: (handler) => subscribe('app-window:reply', handler),
  onWindowClosed: (handler) => subscribe('app-window:closed', handler),
  // 冒烟专用通道：正式启动时主进程没有注册，invoke 会直接失败（不会变成远程执行入口）
  smokeWindow: (view, code) => ipcRenderer.invoke('smoke:window', view, code),
  smokeWindows: () => ipcRenderer.invoke('smoke:windows'),

  // 6. 其它窗口改了配置 / 登录态 / 换库 / 模型 / 产物后，主窗口要跟着刷新
  onConfigChanged: (handler) => subscribe('app:config-changed', handler),
  onAuthChanged: (handler) => subscribe('app:auth-changed', handler),
  onBackendRestarted: (handler) => subscribe('app:backend-restarted', handler),
  onToolBusy: (handler) => subscribe('app:tool-busy', handler),
  onModelsChanged: (handler) => subscribe('app:models-changed', handler),
  onArtifactsChanged: (handler) => subscribe('app:artifacts-changed', handler)
});
