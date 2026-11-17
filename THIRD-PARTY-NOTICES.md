# 第三方组件与资产声明（THIRD-PARTY NOTICES）

本项目自身代码与文档按 [MIT](LICENSE) 授权；随附的第三方组件、开发工具与美术资产按各自的许可证授权，清单如下。
本项目自有的 logo、应用图标、产品名与界面截图属品牌素材，不在 MIT 许可范围内，使用范围见 [NOTICE](NOTICE)。
本清单只列**直接依赖与随包分发的组件**；完整依赖树见 `backend/uv.lock` 与 `desktop/package-lock.json`。
各依赖的**许可全文**（每个包随 wheel 携带的 LICENSE/COPYING，按正文去重）在 `desktop/build/THIRD-PARTY-LICENSES.txt`，
随安装包分发到 `resources/`；本文件只负责「包名 → 许可类型」的对应关系与人工判断结论。

## 1. 桌面端依赖（devDependencies，随安装包分发的运行时）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| Electron（含 Chromium、Node.js） | 44.11.3 | MIT（Chromium 为 BSD-3 等多许可） | 桌面运行时 |
| electron-builder | 26.15.3 | MIT | 打包工具（不随产物运行） |

打包产物里由 electron-builder 自动附带 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`；安装包另附本项目 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`、Python 依赖的许可全文 `THIRD-PARTY-LICENSES.txt` 与 PyInstaller 的许可全文 `PyInstaller-COPYING.txt`（均在 `resources/` 目录）。

安装包构建过程中会用到的辅助二进制：NSIS（zlib/libpng 类许可）、7-Zip（LGPL-2.1，含 unRAR 限制条款）。
它们只作为安装器/解包器存在，完整许可文本随 electron-builder 的产物目录一并提供。

## 2. 后端依赖（Python）

### 2.1 直接依赖（随 `suixinwenda-backend.exe` 一起分发）

| 组件 | 许可证 | 用途 |
|---|---|---|
| FastAPI、Starlette | MIT / BSD-3-Clause | Web 框架 |
| uvicorn | BSD-3-Clause | ASGI 服务器 |
| SQLModel、SQLAlchemy | MIT | ORM |
| PyMySQL | MIT | MySQL 驱动 |
| LangChain、LangGraph、langchain-openai | MIT | 模型编排（LangGraph 仅作为 LangChain 的传递依赖引入，本项目不再用它做记忆存储） |
| openai（SDK） | Apache-2.0 | 模型调用客户端 |
| pypdf | BSD-3-Clause | PDF 文本抽取 |
| python-docx | MIT | Word 文本抽取 |
| openpyxl | MIT | Excel 文本抽取 |
| python-multipart | Apache-2.0 | 表单上传解析 |
| anyio | MIT | 异步线程/取消原语（流式对话的中断与收尾） |
| pydantic | MIT | 数据校验 |

### 2.2 传递依赖（由上面的库引入，随 exe 一起打包）

上一节只列**直接依赖**。下面这些是同一条依赖链上的传递依赖，会被 PyInstaller 一并打进 exe，
因此同样需要声明；完整依赖树见 `backend/uv.lock`（带 sha256）。

| 组件 | 许可证 | 引入方 / 用途 |
|---|---|---|
| certifi | MPL-2.0 | requests / httpx 的 CA 证书束 |
| requests、requests-toolbelt | Apache-2.0 | langchain 生态的 HTTP 客户端 |
| urllib3 | MIT | requests |
| charset-normalizer | MIT | requests 的编码嗅探 |
| idna | BSD-3-Clause | requests 的国际化域名 |
| httpx、httpcore、httpcore2、httpx2、h11 | BSD-3-Clause | openai SDK 与 langsmith 的 HTTP 客户端 |
| distro | Apache-2.0 | openai SDK 的平台识别 |
| jiter | MIT | openai SDK 的增量 JSON 解析 |
| tiktoken | MIT | token 计数 |
| regex | Apache-2.0 AND CNRI-Python | tiktoken 的正则引擎 |
| orjson | MPL-2.0 AND (Apache-2.0 OR MIT) | langchain / langgraph 的高性能 JSON |
| ormsgpack | Apache-2.0 OR MIT | langgraph checkpoint 的序列化 |
| langsmith、langgraph、langgraph-checkpoint、langgraph-prebuilt、langgraph-sdk、langchain-protocol、langchain-core | MIT | langchain 生态的运行时组件 |
| annotated-doc、annotated-types、pydantic-core | MIT | pydantic 及其注解工具 |
| uuid_utils、websockets、truststore | BSD-3-Clause / BSD-3-Clause / MIT | langsmith 与 websockets 传输 |
| lxml | BSD-3-Clause | python-docx / openpyxl 的 XML 解析 |
| et_xmlfile | MIT | openpyxl 的流式写入 |
| xxhash | BSD-2-Clause | langchain-core / langgraph 的缓存键哈希 |
| zstandard | BSD-3-Clause | langgraph 的 checkpoint 压缩 |
| greenlet | MIT AND PSF-2.0 | SQLAlchemy 同步/异步桥 |
| typing-extensions | PSF-2.0 | pydantic / SQLAlchemy 的类型补丁 |
| typing-inspection、packaging、sniffio、click、colorama、jsonpatch、jsonpointer、tenacity | MIT / Apache-2.0 OR BSD-2-Clause / Apache-2.0; MIT / BSD | 通用间接依赖 |

### 2.3 只在打包 / 测试期使用（不进产物）

| 组件 | 许可证 | 用途 |
|---|---|---|
| PyInstaller | GPL-2.0-or-later（bootloader 特殊例外） | 把后端打成 exe（说明见本节末尾） |
| pyinstaller-hooks-contrib | Apache-2.0；GPL-2.0 | PyInstaller 的 hook 集合 |
| altgraph、pefile、pywin32-ctypes | MIT / MIT / BSD-3-Clause | PyInstaller 的依赖 |
| pytest、pytest-cov、coverage | MIT / MIT / Apache-2.0 | 测试与覆盖率 |
| ruff | MIT | lint |

**怎么复核这份清单**：以上内容由实测环境导出（2026-11-17）。在 `backend/` 下执行

```powershell
uv run --with pip-licenses pip-licenses --format=csv --no-version
```

可复现同一份结果。实测全部依赖的许可落在 MIT / BSD（2 条款与 3 条款）/ Apache-2.0 / MPL-2.0 / PSF-2.0 / GPL-2.0
范围内，**没有 AGPL / LGPL**；唯一带传染性的是打包工具 PyInstaller（GPL-2.0-or-later，含 bootloader 特殊例外），
其许可全文随安装包分发。少数包是双许可（例如 `orjson`：Apache-2.0 / MIT / MPL-2.0），清单里按元数据顺序并列，
使用时可任选其一。

`THIRD-PARTY-LICENSES.txt` 里的许可标签取自各包元数据的 `Classifier` 字段，**可能与上游声明的 SPDX 写法略有差异**
（例如 PyInstaller 的 classifier 写 `GPLv2`、正文写 `GPLv2-or-later`）；标签只用于快速浏览，以第 2 节的许可全文为准。

维护口径：**新增直接依赖或升级大版本时，先跑 `uv lock`，再对照本表检查传递依赖是否变化**
（`git diff backend/uv.lock` 里新增的 `name = "..."` 就是要看的地方），并重跑上面的 `pip-licenses` 命令，
最后重新生成许可全文（它由脚本从环境读取，不要手改）：

```powershell
cd desktop
python tools/gen-licenses.py          # 重新生成 build/THIRD-PARTY-LICENSES.txt
python tools/gen-licenses.py --check  # 校验仓库里的版本是否与当前依赖一致
```

**打包时会自动校验**：`npm run dist` 在 electron-builder 之前跑一次 `--check`，不一致就直接失败并提示先跑
`npm run licenses`（实现在 `desktop/tools/build.js`）。依赖升了却没重生成时，安装包里带的就是上一版的许可全文，
这种偏差不会报错，只能靠这一步拦住；`npm run dist:app` 不重装依赖，只校验文件是否存在。

没放进 CI 的原因：许可全文来自**打包机自己的** Python 环境，换平台或换解释器小版本时，wheel 里携带的许可文件
可能不同，放进 CI 会因平台差异误报红；打包机上跑与产物同源，报告不一致就只剩「忘了重新生成」这一种原因。

注意 `pip-licenses` 只导出「包元数据里写的许可证」，**结论仍需人工判断**：同一个库在不同版本换过许可证，
元数据也可能滞后（例如本项目曾把 `openai` 误记为 MIT，实际是 Apache-2.0）。不要把它当成权威结论直接照抄。

**随安装包分发**：PyInstaller（GPL-2.0-or-later，含 bootloader 的特殊例外条款：允许用它将本程序打包并按其自身许可证分发产物）。桌面端的 `resources/backend/suixinwenda-backend.exe` 就是 PyInstaller 产物，因此必须在此声明，不能只当作开发依赖。按 GPL 第 1 条「随程序附一份许可副本」的要求，其**许可全文**随安装包放在 `resources/PyInstaller-COPYING.txt`（源文件 `desktop/build/PyInstaller-COPYING.txt`，与 PyInstaller 6.22.3 发行包内的 `COPYING.txt` 字节一致）；同一份全文也收录在 `THIRD-PARTY-LICENSES.txt` 的 A44 附录里。

## 3. 外部服务（不随本项目分发）

- **MySQL 8**（Community 版为 GPL-2.0 + FOSS 例外）：仅作为独立数据库服务经 `127.0.0.1` 访问，不以库形式链接进本项目；也可换成你自己已安装的 MySQL。
- **DeepSeek / 阿里云百炼（通义千问）API**：由使用者自备 Key 调用，遵守各自的服务条款。本项目与上述公司无关联，也不是它们的官方客户端。

## 4. 美术资产与图标

本节只列**第三方**素材；本项目自有的 logo、应用图标、产品名与界面截图见 [NOTICE](NOTICE)。

- 本项目自有资产：`desktop/build/icon.ico`、`desktop/src/renderer/assets/logo.png`、`logo-mark.png`、
  `logo-mark-dark.png`、`docs/screenshots/*.png`。作者自制，**保留所有权利**，不在 MIT 范围内；
  允许与禁止的使用范围见 [NOTICE](NOTICE)，本文件不重复约定。
- `desktop/src/renderer/index.html` 中三个内联 SVG 图标（回形针 / 书本 / 太阳）路径取自 **Feather Icons**，
  原始项目：<https://github.com/feathericons/feather>。如需替换为自绘图形，改 `index.html` 里对应 `<svg>` 的 `path` 即可。
  MIT 许可要求保留版权声明与许可声明，故照录如下（条款部分与本项目 [LICENSE](LICENSE) 的 MIT 条款逐字相同，
  仅标题行与版权行不同）：

  ```
  The MIT License (MIT)

  Copyright (c) 2013-2023 Cole Bemis

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```
- 界面字体使用系统字体栈（Microsoft YaHei / Segoe UI / Consolas），不内嵌、不分发任何商用字体。

## 5. 代码来源说明

除依赖库外，本项目未内嵌任何第三方源码片段。两处「自己实现」的部分均为 Python 标准库手写：
`backend/core/config.py`（.env 解析）、`backend/core/security.py`（HS256 JWT 与密码摘要）。
