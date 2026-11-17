# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：把后端打成一个能跑服务、也能跑工具的 onedir 目录。

为什么用 onedir 而不是 onefile：
- onefile 每次启动都要把上百 MB 解压到临时目录，「测试连接 / 备份」这类一次性工具
  每次都要多等好几秒，还容易被杀软反复扫描；
- onedir 只解压一次，exe 与 `_internal/` 一起放在 resources/backend/，
  与 desktop/src/tool-run.js 约定的 `resources/backend/suixinwenda-backend.exe <工具>` 完全一致。

产物：dist/suixinwenda-backend/suixinwenda-backend.exe（连同 _internal/）
重新打包：cd backend && uv run pyinstaller --clean --noconfirm suixinwenda-backend.spec
"""

import os

# 版本资源由 desktop/tools/build-backend.js 生成（公司/产品/版本）。
# 没有它就产出「公司、产品、版本全空」的 exe，在 SmartScreen 与杀软评分里等同于未知程序。
# 单跑 spec 时文件可能不存在：存在才传，不让打包因此失败。
_version_file = "build/version_info.txt"
if not os.path.exists(_version_file):
    _version_file = None

# 动态导入的模块：PyInstaller 只做静态分析，下面这些是「运行时按字符串找」的，必须显式列出
hiddenimports = [
    # uvicorn 用字符串选实现（loop / http / websockets / lifespan）
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    # 没装 uvicorn[standard]（httptools / websockets / wsproto），这几个实现模块不存在，
    # 列进 hiddenimports 只会得到一堆 "not found" 警告，uvicorn 自己会回落到 h11 + none
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    # 当前 uvicorn 版本没有 lifespan.auto 模块，列进来只会得到 "not found" 告警
    # SQLAlchemy 的方言是入口点字符串加载的（sqlalchemy.dialects:mysql.pymysql）
    "sqlalchemy.dialects.sqlite",
    "sqlalchemy.dialects.sqlite.pysqlite",
    "sqlalchemy.dialects.mysql",
    "sqlalchemy.dialects.mysql.pymysql",
    "pymysql",
    # launcher.py 按名字 importlib 导入工具模块
    "tools.backup",
    "tools.export",
    "tools.purge",
    "tools.restore",
    "tools.storage_test",
    "tools.db_info",
    "tools.migrate_uploads",
    # 附件解析：core/files.py 按扩展名分支导入，静态分析容易漏
    "pypdf",
    "docx",
    "openpyxl",
]

a = Analysis(
    ["launcher.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 开发期依赖与 GUI 库一律不装进去：pytest/ruff 只会让包变大，
    # tkinter 是 PyInstaller 默认可能拖进来的最大的无用项
    excludes=["tkinter", "pytest", "_pytest", "ruff", "IPython", "matplotlib", "PyQt5", "PySide6"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="suixinwenda-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX 压缩过的 exe 被杀软误报的概率明显更高，宁可大一点
    console=True,  # 桌面端用 windowsHide 起，不会弹黑窗；保留 console 才能正常写 stdout/stderr
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # 公司/产品/版本元数据（见文件头说明）；None 时 PyInstaller 用默认空值
    version=_version_file,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="suixinwenda-backend",
)
