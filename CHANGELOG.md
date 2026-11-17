# 变更记录

本文件格式参考 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

版本号以 `desktop/package.json` 为唯一来源；改完跑 `npm run version:sync`，并在 `backend/` 下跑 `uv lock`
（完整步骤见 [CONTRIBUTING](./CONTRIBUTING.md) 的 PR 检查清单）。

分类含义：**Added** 新增功能、**Changed** 行为变更、**Fixed** 修复、**Security** 安全相关。
只记用户与集成方能感知的变化；内部重构、依赖树细节与调试过程不入本文件。

## [Unreleased]

### Added

- 随安装包附 Python 依赖的许可全文 `THIRD-PARTY-LICENSES.txt`（由 `desktop/tools/gen-licenses.py`
  从实际环境生成、按正文去重，包含每个包随 wheel 携带的 LICENSE/COPYING）；`npm run dist` 会在打包前
  校验它与当前依赖一致，不一致直接失败
- `THIRD-PARTY-NOTICES.md` 补齐 Feather Icons 的 MIT 许可全文与版权行

## [0.1.0] - 2026-11-16

首个公开版本。本机单人使用的桌面 AI 客户端：Electron 窗口 + FastAPI 后端（只监听 `127.0.0.1`），
默认本机 SQLite，可选 MySQL 8。

### Added

- **安装包**：Windows x64 两种形态——`SuiXinWenDa-Setup-<版本>.exe`（NSIS 安装版）与
  `SuiXinWenDa-Portable-<版本>.exe`（免安装），均自带后端，不需要本机装 Python / Node；
  每个 Release 附 `SHA256SUMS.txt` 供核对完整性
- **账号**：注册、密码登录、验证码登录、JWT 会话；不登录也能聊，登录后自动认领本机的匿名会话
- **流式对话**：SSE 逐字返回，Markdown / 代码块 / 表格 / 待办按块增量渲染，可中途停止与重新生成
- **跨轮记忆**：每个会话独立上下文，超出窗口的旧对话自动压成中文摘要落库，不跨会话、不跨设备
- **历史会话**：按今天 / 昨天 / 过去 7 天 / 更早分组，支持搜索、重命名、删除、导出 Markdown
- **文件提问**：图片 / PDF / Word / Excel / txt，点选、拖拽或粘贴，一次最多 9 个，单个 10 MB、合计 30 MB
- **多模型**：兼容任何 OpenAI 协议接口，每个模型一把 Key，可验证、可切换；保存后自动重启后端并复验
- **提示词库**：本机保存常用提问模板，支持搜索、一键复制、删除（只存本机 `localStorage`）
- **存储**：默认本机 SQLite 零安装；可在设置里切到 MySQL 8，含连接测试与走 TLS 的 CA 配置
- **数据管理**：备份（zip）、结构化导出、从备份或导出目录恢复、一键清除本库数据
- **桌面体验**：深浅主题、三档字号、独立子窗口（设置 / 历史 / 模型 / 提示词库等）、
  启动小窗展示真实启动阶段、离线自动重连、菜单快捷键
- **文档**：README（中英）、使用手册、配置与接口、踩坑与 FAQ、打包与发布、页面设计规范，
  以及隐私、安全、贡献、支持、行为准则与第三方许可声明

### Security

- 验证码默认**不回显**到响应体（`DEMO_CODE_MODE=0`），只写服务端日志；演示模式需显式打开
- 密码用 PBKDF2-HMAC-SHA256（60 万次迭代 + 每用户随机盐）存储，旧摘要登录成功后自动升级；
  同账号连续失败 5 次锁 5 分钟，账号不存在时也跑一次同等开销的摘要运算以消除时序差
- 慢哈希全局限流：与账号无关的每分钟预算，挡住「换随机账号绕过单账号锁定」的算力放大
- 上传按块读取、超限立即中断；文档解析设页数与字符上限
- 桌面端开启 `sandbox` 与上下文隔离、无 `nodeIntegration`，CSP 收窄 `connect-src`，
  外链先确认再交系统浏览器，权限只放行剪贴板写
- 模型 Key 与登录令牌用系统能力加密保存（Windows 走 DPAPI），运行期明文目录启动时先清理
- 安装包随包附 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md` 与 PyInstaller 许可全文

### 已知限制

只在本机单人场景可用：无 HTTPS、无限流、无多租户，不可直接部署到公网；
不联网搜索、不调工具；仅提供 Windows x64 产物。完整边界见 [README 第 5 节](./README.md#5-已知限制)。
