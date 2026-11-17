"""数据库后端的唯一口径：用哪个库、库在哪。

解析顺序（严格按此实现）：
1. DB_BACKEND 显式写了 sqlite / mysql → 用它
2. 未写，但 DB_HOST 非空 → mysql
   只看 DB_HOST，不看「DB_USER/DB_PASSWORD/DB_NAME 都非空」：
   本机 MySQL 常见 root 空密码，用四项判据会把这类老用户判成 sqlite，
   他们会看到空列表并以为数据丢了——这是本模块唯一「判错就丢数据」的地方
3. 其余 → sqlite

本模块只做纯配置解析：不 import database、不 import models（否则循环导入）。
"""
import logging
import os
import re
from pathlib import Path

import core.config  # noqa: F401  确保 .env 已加载（load_env 在 import 期执行）

logger = logging.getLogger(__name__)

BACKEND_SQLITE = "sqlite"
BACKEND_MYSQL = "mysql"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
# SQLite 主文件名
DB_FILENAME = "suixinwenda.db"
# WEB 端口/超时口径见 database.py；这里只放「库身份」相关的常量


def db_backend() -> str:
    """当前后端。绝不抛异常——它会在 models 导入期被调用，导入期抛异常让错误无法定位。"""
    explicit = os.environ.get("DB_BACKEND", "").strip().lower()
    if explicit in (BACKEND_SQLITE, BACKEND_MYSQL):
        return explicit
    return BACKEND_MYSQL if os.environ.get("DB_HOST", "").strip() else BACKEND_SQLITE


def data_dir() -> Path:
    """数据根目录：DATA_DIR 或默认 backend/data。

    每次调用都读环境变量：模块级常量会在 import 时固定，测试的 monkeypatch
    与打包后的 DATA_DIR 都不会生效，而且全程不报错——只会静默读写错目录。
    """
    override = os.environ.get("DATA_DIR", "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "data"


def sqlite_path() -> Path:
    """SQLite 文件位置。必须返回绝对路径：相对路径会让连接串跟着 cwd 漂。"""
    return (data_dir() / DB_FILENAME).resolve()


def is_remote() -> bool:
    """当前 MySQL 是不是连在本机之外。

    SQLite 恒为 False：它就是一个本地文件，不存在「远程」这回事。
    """
    if db_backend() != BACKEND_MYSQL:
        return False
    return os.environ.get("DB_HOST", "").strip() not in LOCAL_HOSTS


def allow_remote() -> bool:
    """用户是否显式同意「聊天记录离开本机」。"""
    return os.environ.get("DB_ALLOW_REMOTE", "").strip() == "1"


def storage_scope() -> str:
    """当前库的「身份」：附件目录与自动备份按它分池。

    为什么不能只用 sqlite / mysql：本地 MySQL 与远程 MySQL 是两个完全不同的库，
    共用 `uploads/mysql` 时，空库启动的孤儿清理会把另一个库的附件全删掉
    （cleanup_orphans 用「当前库引用全集」当白名单）。同理自动备份也要分开，
    否则两边互相挤占那 5 份配额。

    只用 host/port/name 拼，绝不含账号口令；清洗成安全字符，避免路径里出现 `:` 与 `/`
    （IPv6 地址、含斜杠的库名都会破坏路径与文件名）。
    """
    if db_backend() == BACKEND_SQLITE:
        return BACKEND_SQLITE
    host = os.environ.get("DB_HOST", "").strip() or "unknown"
    port = os.environ.get("DB_PORT", "3306").strip() or "3306"
    name = os.environ.get("DB_NAME", "").strip() or "unknown"
    slug = re.sub(r"[^a-z0-9]+", "-", f"{host}-{port}-{name}".lower()).strip("-")
    return f"mysql-{(slug or 'db')[:60].strip('-')}"


def ssl_skip_identity() -> bool:
    """是否放宽 TLS 的主机名校验（只校验证书链，不校验证书与主机名是否匹配）。

    只给「本机自签证书」这一种场景用：MySQL 官方镜像的自签证书 CN 是
    MySQL_Server_8.0.x，用 127.0.0.1 连必然主机名不匹配。云厂商 CA 的证书带正确 SAN，
    不需要这个开关，所以默认关闭（即默认做主机名校验）。
    """
    return os.environ.get("DB_SSL_NO_VERIFY_IDENTITY", "").strip() == "1"


def ssl_connect_args() -> dict:
    """有 DB_SSL_CA 就走 TLS 并校验证书；没有就返回空 dict（pymysql 用默认的非加密连接）。

    远程库跨公网时必须加密：不加 TLS 等于账号密码与全部聊天内容明文过网络。
    默认同时校验证书链与主机名：只校验链时，任何一张该 CA 签发的证书都能冒充目标服务器。
    """
    if db_backend() != BACKEND_MYSQL:
        return {}
    ca = os.environ.get("DB_SSL_CA", "").strip()
    if not ca:
        return {}
    args = {"ssl_ca": ca, "ssl_verify_cert": True}
    if ssl_skip_identity():
        logger.warning("已关闭 TLS 主机名校验（DB_SSL_NO_VERIFY_IDENTITY=1）：仅限本机自签证书使用")
    else:
        args["ssl_verify_identity"] = True
    return args


def validate_ssl() -> None:
    """CA 配了但文件不在时提前报中文：否则 pymysql 会抛一句 FileNotFoundError 让人摸不着头脑。"""
    if db_backend() != BACKEND_MYSQL:
        return
    ca = os.environ.get("DB_SSL_CA", "").strip()
    if not ca:
        return
    if not Path(ca).is_file():
        raise RuntimeError(
            f"DB_SSL_CA 指向的证书文件不存在（{Path(ca).name}）：请在设置里重新选择 CA 文件，"
            "或清空该项改用非加密连接（仅本机库可接受）"
        )


def describe() -> dict:
    """给日志、健康检查与桌面包用的库描述（不含绝对路径）。"""
    return {
        "backend": db_backend(),
        "location": _display_location(),
        # 库身份：附件与备份按它分池，桌面端列表也要能看出「哪个库」
        "scope": storage_scope(),
        # 连接表单回显用：桌面端「设置 → 数据与备份 → 切换存储」要显示当前真正生效的值。
        # 只用白名单几键，DB_PASSWORD 永远不进来——它在任何接口 / IPC 响应里都不该出现。
        "connection": connection_view(),
    }


def connection_view() -> dict:
    """当前生效的 MySQL 连接参数（不含密码）。SQLite 全部返回空串，让前端保留默认值。"""
    if db_backend() != BACKEND_MYSQL:
        return {
            "host": "",
            "port": "",
            "user": "",
            "name": "",
            "remote": False,
            "allow_remote": False,
            "ssl": False,
            "ssl_ca": "",
        }
    ssl_ca = os.environ.get("DB_SSL_CA", "").strip()
    return {
        "host": os.environ.get("DB_HOST", "").strip(),
        "port": os.environ.get("DB_PORT", "3306").strip() or "3306",
        "user": os.environ.get("DB_USER", "").strip(),
        "name": os.environ.get("DB_NAME", "").strip(),
        # 这三个是「连接性质」而不是连接参数：界面靠它决定要不要显示远程警示与勾选状态
        "remote": is_remote(),
        "allow_remote": allow_remote(),
        "ssl": bool(ssl_ca),
        # CA 路径要回显：不回显的话，用户改一次连接就会把 TLS 静默丢掉（或清不掉）
        "ssl_ca": ssl_ca,
    }


def _display_location() -> str:
    """只暴露相对路径或文件名，绝不返回绝对路径。

    打包后 DATA_DIR 是 %APPDATA%/suixinwenda/data，直接回绝对路径会把用户名
    与目录结构暴露到接口响应和日志里。
    """
    if db_backend() == BACKEND_MYSQL:
        host = os.environ.get("DB_HOST", "")
        port = os.environ.get("DB_PORT", "3306")
        name = os.environ.get("DB_NAME", "")
        return f"{host}:{port}/{name}"

    backend_dir = Path(__file__).resolve().parent.parent
    path = sqlite_path()
    try:
        return path.relative_to(backend_dir).as_posix()
    except ValueError:
        return path.name


def validate_remote() -> None:
    """非本机 MySQL 必须显式放行：聊天记录会离开这台机器。

    单独成函数而不是塞进 describe()：describe 会被健康检查反复调用，
    那里抛异常会把「库配错了」表现成「后端挂了」。
    """
    if db_backend() != BACKEND_MYSQL:
        return
    host = os.environ.get("DB_HOST", "").strip()
    if host in LOCAL_HOSTS or os.environ.get("DB_ALLOW_REMOTE", "").strip() == "1":
        return
    raise RuntimeError(
        f"DB_HOST 指向非本机地址（{host}）。聊天记录会离开本机；"
        "确认要这样请在「设置 → 数据与备份 → 切换存储」里勾选「允许连接远程」，或设置 DB_ALLOW_REMOTE=1"
    )
