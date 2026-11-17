"""配置加载：把 backend/.env 读入环境变量并提供取值（stdlib 实现，不引入第三方依赖）。"""
import os
import re
import sys
from pathlib import Path

# .env 位置：SUIXINWENDA_ENV_FILE 优先（桌面端托管时指向 userData/config.env——
# 打包后安装目录只读、也没有 backend/.env）；未设置时保持原行为，仍读 backend/.env。
# 这里是模块级常量，与「DATA_DIR 必须在函数内求值」的坑不同：load_env() 一个进程只跑一次，
# 而 env 文件路径本身就是进程级配置，晚改没有意义。
ENV_PATH = Path(
    os.environ.get("SUIXINWENDA_ENV_FILE") or (Path(__file__).resolve().parent.parent / ".env")
)


def load_env(path: Path = ENV_PATH) -> None:
    """解析 .env 的 KEY=VALUE 行；已存在的环境变量优先，不覆盖。"""
    # 1. 文件不存在直接返回（测试等场景可只靠环境变量）
    if not path.exists():
        return
    # 2. 逐行跳过注释与空行，写入 os.environ（外部环境变量优先）
    #    utf-8-sig 而不是 utf-8：Windows 记事本保存的 .env 带 BOM，BOM 会粘在第一个键名上
    #    （变成了 "\ufeffDB_HOST"），结果整份配置一个键都读不到——表现为「老用户被判成 sqlite、
    #    会话列表全空」，看起来像数据丢了。utf-8-sig 对无 BOM 的文件行为一致。
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # 成对引号先剥掉（`KEY="abc"` 取 abc），引号内的 # 是值的一部分
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        # 行内注释（`KEY=abc # 说明`）再去掉，否则说明文字会被当成值的一部分。
        # 只认「空白 + #」：口令/Key 里的 `#`（如 DB_PASSWORD=ab#12）是值的一部分，
        # 直接按 # 切会把口令截断，表现为一句看不懂的 Access denied
        elif "#" in value:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        if key and key not in os.environ:
            os.environ[key] = value


def require(key: str) -> str:
    """取必填配置；缺失直接报中文错误，避免带病启动。

    两种来源：
    1. 环境变量里有明文（桌面端托管启动 / 工具子进程会解密后注入，用户也可以自己 export）；
    2. 配置文件里的明文行（用户手动维护的 .env，手动跑 uvicorn 走这条）。
    只有 `<KEY>_ENC` 时说明是桌面端加密存的，而后端没有解密能力（见下面注释），
    这里给一句能照做的中文，而不是让 pymysql 报一个看不懂的连接失败。
    """
    value = os.environ.get(key, "").strip()
    if value:
        return value
    encrypted = os.environ.get(f"{key}_ENC", "").strip()
    if encrypted:
        # 为什么后端不自己解：safeStorage 在 Windows 上是 Chromium 的 v10 格式
        # （AES-256-GCM，密钥经 DPAPI 包在浏览器 Local State 里），
        # 后端要解就得引加密库并复刻 Chromium 的实现细节；
        # 而任务口径本来就是「后端只认明文，由桌面端解密后注入」。
        raise RuntimeError(
            f"{key} 在配置里是加密存储的（{key}_ENC），只有桌面端能解密。"
            "请用桌面端启动（它会解密后注入），或在 backend/.env 里写一份明文 "
            f"{key}（手动启动后端时用，桌面端下次启动会重新加密）。"
        )
    raise RuntimeError(f"缺少配置项：{key}，请检查 backend/.env")



load_env()
# Windows 控制台默认 GBK，日志与异常里的中文会乱码；stdout 与 stderr 都要切 UTF-8（.x 中文可读）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")
