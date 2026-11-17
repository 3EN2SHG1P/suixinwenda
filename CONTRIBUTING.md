# 贡献指南

欢迎 Issue 与 PR。开工前花 3 分钟看完这页，能省掉来回改。

## 1. 先把项目跑起来

环境前提：Python 3.12+、[uv](https://docs.astral.sh/uv/)、Node.js **22+**（`electron@44` 要 ≥22.12、`eslint@10` 要 ≥22.13，CI 固定用 22）。
数据库**不用装**：默认本机 SQLite；想用 MySQL 8 再起仓库自带的 `docker-compose.yml`。

照着 [README](README.md) 第 2 节做，确认这 4 件事都对：

- 后端起来：<http://127.0.0.1:8010/docs> 能打开，`/api/v1/health` 返回 `code: 0`
- 桌面端窗口能起：不白屏，消息区没有离线横幅
- 输入框能打字能发送，回答逐字出现
- 再问「我刚才问了什么」能答上来（记忆生效）

跑不起来先看 [docs/踩坑与FAQ.md](docs/踩坑与FAQ.md)，还不行再开 Issue（按 `.github/ISSUE_TEMPLATE/bug_report.yml` 的字段填）。

## 2. 改代码时注意什么

| 你想改 | 先看 | 说明 |
|---|---|---|
| 界面与交互 | `desktop/src/renderer/` | 原生 HTML/CSS/JS，无框架无构建，改完需关掉窗口重开（原生菜单里没有 Reload，`Ctrl+R` 不生效） |
| 独立子窗口 | `desktop/src/app-windows.js` + `renderer/views/` | 新增一扇窗只做两件事：`WINDOW_DEFS` 加一条、写一个实现 `window.SXW_VIEWS.<名字>` 的视图文件；标题栏 / 拖动 / 缩放 / 位置记忆 / 主题字号跟随都由共用壳 `app-window.html` 提供 |
| 样式与配色 | `desktop/src/renderer/styles.css` 的 `:root` 与 `[data-theme='dark']` | 只改 Token，不在组件里写死颜色；规范见 `docs/dev/页面设计规范.md` |
| 数值参数（尺寸、超时、阈值） | 文件顶部常量区 | 常量集中在各文件顶部，注释写明用途；别在函数里写魔数 |
| 接口字段与返回结构 | `backend/routers/` + `backend/schemas/` | 前后端字段名要一起改，桌面端在 `app.js` / `views/` 里对应 |
| 环境变量、接口清单 | `docs/配置与接口.md` | 加 / 改 `.env` 键或接口路径时同一 PR 内更新 |
| 技术约束 | `docs/踩坑与FAQ.md` | 踩过的坑与硬约束都记在这里，改之前先扫一遍 |

分层的约定：`routers/` 只解析请求与映射状态码，业务逻辑放 `core/`，表定义放 `models/`，校验模型放 `schemas/`。

## 3. 分支与提交

- 基线分支：`main`（PR 请从最新 `main` 切出，别基于别人的特性分支）
- 分支命名：`feat/短描述`、`fix/短描述`、`docs/短描述`
- 提交信息用中文，一行说清改了什么：

  ```
  fix: 修复删会话后模型仍记得内容的问题
  feat: 模型下拉支持显示上下文长度
  docs: 补充附件格式支持清单
  ```

- 一次提交只做一件事，别把格式化、重构、功能混在一起。

## 4. PR 检查清单

提交前自己过一遍（Windows PowerShell 不支持 `&&`，逐行执行）。下面与 `.github/workflows/ci.yml` 是同一套门禁：
**CI 会跑的项不必贴证据，CI 不跑的项（冒烟、打包）必须自己跑完并在 PR 里贴结果**。

**CI 会跑的（本地先过一遍能省一轮往返）**

- [ ] 后端 lint 与单测：`cd backend` → `uv run ruff check .` → `uv run pytest -q`
      （默认跑 SQLite，不需要任何数据库服务；末行 `N passed` 贴进 PR 描述）
- [ ] 后端覆盖率（CI 有 80% 门槛；改了核心逻辑就在本地跑一遍，别等 CI 报红）：
      `uv run pytest -q --cov=core --cov=routers --cov=models --cov=tools --cov=schemas --cov-report=term-missing --cov-fail-under=80`
- [ ] 后端 MySQL 方言契约（可选，需本机有 MySQL 8）：
      `cd backend` → `$env:TEST_MYSQL="1"` → `uv run pytest -q tests/test_dialect_contract_mysql.py tests/test_restore.py`
- [ ] 桌面端：`cd desktop` → `npm run lint` → `npm run version:check` → `npm run check:globals` → `npm test`
      → `npm audit --omit=dev --audit-level=high` → `npm run test:cov`（覆盖率只输出、不设门槛，看一眼有没有明显塌方即可）

**CI 不跑的（必须本地跑完并贴结果）**

- [ ] 改了界面 → 附改后截图，且 `cd desktop` → `npm run smoke` 尾行 `[SMOKE] PASS`
- [ ] 改了打包相关 → `npm run dist` 并确认产物能启动

**需要人看的内容（没有自动检查）**

- [ ] 改了后端接口 → 有用例覆盖，且错误分支也测了
- [ ] 改了参数 → 文件顶部常量与 `docs/配置与接口.md` 同步更新
- [ ] 修了 bug → `docs/踩坑与FAQ.md` 补了现象 / 根因 / 处理
- [ ] 动了文档结构 → README 的「文档地图」与 `docs/README.md` 索引同步更新
- [ ] 有用户可见的变化 → `CHANGELOG.md` 的 `[Unreleased]` 段按 Added / Changed / Fixed / Security 记一条
- [ ] 改了版本号 → 只改 `desktop/package.json`，再跑 `npm run version:sync`
      （会一并写入 `pyproject.toml`、双 README 徽章、设置页「关于」的常量与 `package-lock.json`）；
      同时在 `backend/` 下跑 `uv lock` 刷新 `uv.lock`，否则 CI 的 `uv sync --frozen` 会失败
- [ ] 增删依赖或升级大版本 → 在 `backend/` 下 `uv lock`，再 `cd desktop` 跑 `npm run licenses` 重新生成
      `build/THIRD-PARTY-LICENSES.txt` 一并提交（`npm run licenses:check` 可自检；`npm run dist` 也会自动校验，
      不一致直接失败）
- [ ] 新增图片 / 字体 / 图标 / 代码片段已注明来源与许可证（写进 `THIRD-PARTY-NOTICES.md`），来源不明的资产一律不收
- [ ] 没有把 `.env`、日志（含 `start.log`）、截图草稿、`node_modules`、`dist` 提交进来

## 5. 不接受的改动

| 类型 | 原因 |
|---|---|
| 引入前端框架或打包步骤（React/Vue/Vite 等） | 本项目的取舍就是零构建、改完刷新即生效 |
| 把后端改成需要公网可访问的部署形态（加 HTTPS、多租户、限流） | 定位是个人本机使用，超出范围 |
| 提交真实 API Key、数据库口令、内网地址 | 一律打回 |
| 大范围重排文件、顺手格式化整个文件 | 让 review 无法聚焦，请拆成独立 PR |

## 6. 报问题的正确姿势

Issue 里请带上：

1. 你做了什么（哪一步、点了哪里）；
2. 期望看到什么、实际看到什么；
3. 关键输出：后端日志、桌面端控制台报错、`/api/v1/health` 的返回；
4. 环境：操作系统、Python / Node 版本、是否用 Docker 起库。

截图比文字描述更有用。**安全漏洞不要开公开 Issue**，走 [SECURITY.md](SECURITY.md) 的私密渠道。

## 7. 许可提醒

提交代码即表示同意你的贡献按本项目 [MIT 许可](LICENSE) 授权。
logo、产品名「随心问答 / SuiXinWenDa」、`docs/screenshots/` 下的界面截图属于品牌素材，**保留所有权利**，不在 MIT 许可范围内（范围与允许用法见 [NOTICE](NOTICE)）；**不接受**把它们用作其他项目的图标或品牌标识的改动。
第三方组件与资产的许可清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
