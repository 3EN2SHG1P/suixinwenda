# 隐私说明

本文件说清「你的数据存在哪、会发给谁、怎么删」。本项目是本机运行的开源软件，没有运营方服务器。

## 1. 存在这台机器上的数据

| 数据 | 位置 | 说明 |
|---|---|---|
| 账号（账号、密码摘要、昵称） | 默认本机 SQLite `backend/data/suixinwenda.db` 的 `users` 表；切到 MySQL 后在你配置的数据库里 | 密码只存 PBKDF2 摘要，不可逆 |
| 会话标题与聊天记录 | 同上，`conversations` / `chat_messages` 表 | 删除会话即一并删除 |
| 对话历史与摘要（「对话历史」窗口展示的内容） | 同上，`chat_messages` / `chat_summaries` 表 | 摘要属于对话内容的浓缩，与聊天记录同库；删除会话时一并清理 |
| 登录令牌 | `%APPDATA%\suixinwenda-desktop\auth.bin` | 由系统级加密（Windows 走 DPAPI）保护，只有当前系统账户能解开；退出登录即删除 |
| 接口地址、主题、字号、自动备份设置 | `%APPDATA%\suixinwenda-desktop\config.json` | 明文配置，可手动删除 |
| 模型 API Key | `%APPDATA%\suixinwenda-desktop\models.json` | 用系统能力加密保存（Windows 走 DPAPI），界面不回显；系统加密不可用时降级为明文并在 `main.log` 记录一条警告；每个模型用自己的 Key |
| 数据库口令 | 打包态 `%APPDATA%\suixinwenda-desktop\config.env`、开发态 `backend/.env`，键名 `DB_PASSWORD_ENC` | 系统加密保存（Windows 走 DPAPI），界面不回显；明文只在托管启动时由桌面端注入给后端进程 |
| 上传的附件原文件 | 本机 `data/uploads/<库身份>/`（开发态 = `backend/data/uploads/`，安装版 = `%APPDATA%\suixinwenda-desktop\data\uploads\`；按内容哈希分目录，同文件只存一份） | 只在本机，不经过任何第三方存储；删除会话时一并清理 |
| 提示词库（常用提问模板） | 本机应用的 localStorage（`%APPDATA%\suixinwenda-desktop` 下的 Local Storage） | 只在本机，不上传、不参与备份 |
| 附件元数据与抽取正文 | 与会话同库（`chat_attachments`） | 供消息里的附件卡片与文档预览使用；删除会话即删 |
| 备份与导出产物 | 应用数据目录 `backups/` `exports/` 等你选择的位置 | 只在本机；设置里可以逐条删除或按天数清理 |

**存储位置口径**：默认是本机 SQLite 单文件，不经过任何服务器。你可以在「设置 → 数据与备份 → 切换存储」里改用 MySQL：

- 填 `127.0.0.1` / `localhost`：仍然只在本机；
- 填其他地址：**聊天记录与附件元数据会保存到那台服务器上**，相当于你主动把这部分数据交给你信任的机器，建议同时配置 SSL CA 走 TLS（附件原文件仍只在本机）。

## 2. 会发出去的数据

- **聊天内容与附件内容会发送给你自己配置的模型服务商**：图片以 base64、文档以抽取出的文本，随请求发往「设置 → 模型」里那个模型的 Base URL。它们的处理规则遵循各自的服务条款与隐私政策。
- 本机后端只监听 `127.0.0.1`，桌面前端只连本机地址（设置里也只接受本机 http 地址）。
- 除模型服务商外，本项目**不上报**任何遥测、不接第三方统计、不访问任何 CDN（界面与字体全部本地）。界面右上角的通知只在本机显示，不产生任何网络请求。
- 附件文件名与抽取正文会随附件记录留在本机数据库里（用于消息里的附件卡片与文档预览），原文件留在本机磁盘；两者都不会发给模型服务商以外的地方。

## 3. 怎么删

- 删单个会话：左侧列表右键 → 删除（同时清掉该会话的消息、摘要、附件记录与仅被它引用的附件文件）。
- 删当前存储里的全部数据：**设置 → 数据与备份 → 危险区 → 一键清除本库数据**（账号保留；不可恢复，建议先备份）。
- 手动删库：默认存储直接删 `backend/data/suixinwenda.db`；MySQL 则 `DROP DATABASE suixinwenda;`（或删掉 docker 卷 `suixinwenda-mysql-data`）。
- 清桌面端登录态与配置：应用内「退出登录」，或删掉 `%APPDATA%\suixinwenda-desktop\` 下的 `auth.bin` / `config.json` / `models.json`。

## 4. 关于他人数据

请勿把含他人个人信息、商业秘密或受监管数据的文件上传给第三方模型服务，除非你已获得相应授权。
