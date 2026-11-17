## 这个 PR 做了什么

<!-- 一句话说清改了什么、为什么改 -->

## 检查清单

与 `.github/workflows/ci.yml` 是同一套门禁：**CI 会跑的不必贴证据，CI 不跑的要自己跑完并贴结果**。

**CI 会跑**

- [ ] 后端：`cd backend` → `uv run ruff check .` → `uv run pytest -q`（末行 `N passed` 贴到下面）
- [ ] 后端覆盖率（改了核心逻辑时）：`uv run pytest -q --cov=core --cov=routers --cov=models --cov=tools --cov=schemas --cov-report=term-missing --cov-fail-under=80`
- [ ] 桌面端：`cd desktop` → `npm run lint` → `npm run version:check` → `npm run check:globals` → `npm test`
      → `npm audit --omit=dev --audit-level=high` → `npm run test:cov`（覆盖率只输出、不设门槛）

**CI 不跑（必须本地跑完）**

- [ ] 改了界面 → 附改后截图，且 `npm run smoke` 尾行 `[SMOKE] PASS`
- [ ] 改了打包相关 → `npm run dist` 并确认产物能启动

**需要人看的内容**

- [ ] 改了后端接口 → 有用例覆盖，且错误分支也测了
- [ ] 改了参数 → 文件顶部常量与 `docs/配置与接口.md` 同步更新
- [ ] 修了 bug → `docs/踩坑与FAQ.md` 补了现象 / 根因 / 处理
- [ ] 动了文档结构 → README 的「文档地图」与 `docs/README.md` 索引同步更新
- [ ] 有用户可见的变化 → `CHANGELOG.md` 的 `[Unreleased]` 段按 Added / Changed / Fixed / Security 记一条
- [ ] 改了版本号 → 只改 `desktop/package.json` 后跑 `npm run version:sync`（含 pyproject、双 README 徽章、设置页常量、package-lock），并在 `backend/` 下跑 `uv lock`
- [ ] 没有把 `.env`、日志（含 `start.log`）、截图草稿、`node_modules`、`dist` 提交进来
- [ ] 增删依赖或升级大版本 → `cd desktop` 跑 `npm run licenses` 重新生成 `build/THIRD-PARTY-LICENSES.txt` 并提交
- [ ] 新增的图片 / 字体 / 图标 / 代码片段已注明来源与许可证（填在下面）

## 自检输出

```
（粘贴 pytest 末行与 [SMOKE] 尾行）
```

## 新增第三方资产（如有）

| 文件 | 来源 | 许可证 |
|---|---|---|
|  |  |  |
