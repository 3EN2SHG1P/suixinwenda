# 获取帮助

先说明：本项目是**个人维护**的开源项目，没有客服、没有 SLA，维护者按自己的时间处理 Issue。

## 1. 提问前先自查（能解决八成问题）

| 症状 | 先看 |
|---|---|
| 窗口没起来 / 报「缺少配置项」/ 连不上数据库 | [README 第 4 节](README.md#4-跑不起来怎么办) → 仓库根目录的 `start.log`（逐阶段记录停在哪一步与退出码） |
| 具体报错的根因与处理 | [docs/踩坑与FAQ.md](docs/踩坑与FAQ.md)（按现象分类，给现象 / 根因 / 处理） |
| 某个按钮怎么点、某个设置是什么意思 | [docs/使用手册.md](docs/使用手册.md) |
| 环境变量、接口、备份恢复的行为 | [docs/配置与接口.md](docs/配置与接口.md) |
| 数据存在哪、会不会上传 | [PRIVACY.md](PRIVACY.md) |

## 2. 在哪提问

- **Bug**：按 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml) 开 Issue（必填版本、环境、复现步骤、关键日志）
- **功能建议**：按 [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.yml) 开 Issue，说明使用场景比说明做法更有用
- **文档看不懂 / 写错了**：直接开 Issue 指出位置，这类反馈优先级很高
- **安全漏洞**：**不要开公开 Issue**，走 [SECURITY.md](SECURITY.md) 的私密渠道

## 3. 不在支持范围内

- 把后端暴露到公网、多用户共用、加 HTTPS / 限流 / 多租户（超出「本机单人」的设计边界，见 README「已知限制」）
- 帮忙打包 macOS / Linux 版本（需自行补 electron-builder 配置）
- 帮忙申请或代填模型 API Key、代付模型费用
- 第三方模型服务的账号、计费与条款问题（找对应服务商）

## 4. 提 Issue 时请自带的信息

1. 你是哪种用法：安装版（Releases 下载）还是源码（`git clone` 后 `start.ps1`）
2. 版本：应用内「设置 → 关于」；源码方式贴 `git rev-parse --short HEAD`
3. 环境：Windows 版本、Python / Node 版本（源码方式）、数据库是 SQLite 还是 MySQL
4. 关键输出：`start.log` 末 20 行、`backend/backend.log` 末尾、`/api/v1/health` 的返回
5. **不要贴真实 API Key、数据库口令、聊天记录原文**——打码后再贴

## 5. 响应的现实预期

- 安全问题按 [SECURITY.md](SECURITY.md) 承诺的 7 天内首次回复
- 普通 Issue 不承诺时限；能复现、信息完整的会优先处理
- 与项目定位冲突的改动（见 [CONTRIBUTING.md](CONTRIBUTING.md) 第 5 节）会被礼貌拒绝
