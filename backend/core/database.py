"""数据库引擎：按 db_info 的口径拼连接串、建 engine，提供启动建表与连库探活。

方言差异只允许出现在本文件与 core/db_info.py，业务代码一律不判断后端类型。
"""
import os
from urllib.parse import quote

from sqlalchemy import create_engine, event, text
from sqlmodel import SQLModel

import models  # noqa: F401  导入即把业务表注册进 metadata
from core import db_info
from core.config import require

# 连接池参数（单人本机场景）：连接数上界 = pool_size + max_overflow = 10，
# 够两三条并发流式请求同时占用而不排队
POOL_SIZE = 5
MAX_OVERFLOW = 5
POOL_TIMEOUT_SECONDS = 10
# 建立 TCP 连接的超时：远程库/网络不通时必须尽快失败。
# 不设的话由 pymysql 默认 10s 兜着，但显式写出来，远程场景才有据可查
CONNECT_TIMEOUT_SECONDS = 10
# pool_recycle 必须小于 MySQL 的 wait_timeout（默认 8 小时）：
# 否则连接先被服务端掐断，pool_pre_ping 只能兜住错误，省不掉那次重连往返
POOL_RECYCLE_SECONDS = 1800
# SQLite 等写锁的上限（毫秒）：不给的话并发写会立刻抛 database is locked，
# 摘要刷新这类后台任务会表现为「永远不刷新、日志里只有一行被忽略」
SQLITE_BUSY_TIMEOUT_MS = 30000

def database_url() -> str:
    """当前后端的连接串。

    sqlite 分支绝不调用 require()：新用户根本没配 DB_USER 这些键，
    取一次就是「缺少配置项」直接起不来。
    """
    db_info.validate_remote()
    # CA 文件配了却不在，必须在拼连接串之前拦下：否则报的是一句 FileNotFoundError
    db_info.validate_ssl()
    if db_info.db_backend() == db_info.BACKEND_SQLITE:
        # 目录必须先存在：SQLite 不会替你建父目录，第一次连接就是「unable to open database file」
        db_info.sqlite_path().parent.mkdir(parents=True, exist_ok=True)
        # as_posix()：Windows 反斜杠在 URL 里会被当转义，正斜杠两边都认
        return f"sqlite:///{db_info.sqlite_path().as_posix()}"

    # 「只写了 DB_HOST」是最容易踩的半配置：直接报「缺少配置项」不告诉人下一步该干嘛
    missing = [key for key in ("DB_USER", "DB_NAME") if not os.environ.get(key, "").strip()]
    if missing:
        raise RuntimeError(
            f"DB_HOST 已有值（按 MySQL 处理），但缺少 {'、'.join(missing)}。"
            "想用本机 SQLite 的话，把 backend/.env 里的 DB_HOST 注释掉，或设 DB_BACKEND=sqlite"
        )

    # 用户名与口令必须 URL 编码：含 @ / : # 等字符时不编码会拼出错误的连接串。
    # 只用 quote 不用 quote_plus：后者把空格编成 `+`，而 SQLAlchemy 解析 URL 用的是
    # unquote（不会把 `+` 还原成空格），口令里带空格就会以 `+` 去登录。
    return (
        f"mysql+pymysql://{quote(require('DB_USER'), safe='')}:{quote(require('DB_PASSWORD'), safe='')}"
        f"@{require('DB_HOST')}:{os.environ.get('DB_PORT', '3306')}"
        f"/{quote(require('DB_NAME'), safe='')}?charset=utf8mb4"
    )


def _engine_kwargs() -> dict:
    """按方言给 engine 参数：SQLite 没有连接池预热的意义，也没有 MySQL 那些池参数。"""
    if db_info.db_backend() == db_info.BACKEND_SQLITE:
        return {
            # check_same_thread=False：流式生成在 anyio 的线程里跑，连接会跨线程使用；
            # timeout 是「拿不到写锁最多等几秒」，与下面的 busy_timeout 同量级
            "connect_args": {"check_same_thread": False, "timeout": 30},
            "pool_pre_ping": False,
        }
    return {
        "pool_pre_ping": True,
        "pool_recycle": POOL_RECYCLE_SECONDS,
        "pool_size": POOL_SIZE,
        "max_overflow": MAX_OVERFLOW,
        "pool_timeout": POOL_TIMEOUT_SECONDS,
        # 远程库：连接建立要有上限，有 CA 证书就走 TLS（见 db_info.ssl_connect_args）
        "connect_args": {"connect_timeout": CONNECT_TIMEOUT_SECONDS, **db_info.ssl_connect_args()},
    }


engine = create_engine(database_url(), **_engine_kwargs())

if db_info.db_backend() == db_info.BACKEND_SQLITE:

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record):
        """每条新连接都要设：WAL 让读写不互相阻塞，busy_timeout 把「立刻 locked」变成「等一下」。

        synchronous=NORMAL 在 WAL 下足够安全（断电最多丢最后一个事务，不会坏库），
        比默认 FULL 快一个量级。foreign_keys 必须显式打开：SQLite 默认不校验外键。
        """
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()

# 需要在既有表上补的索引（唯一源，core/migrations.py 直接复用这一份）：
# create_all 只建缺失的表，不会给老表加索引，所以每条都要能被幂等补上
INDEX_MIGRATIONS = (
    ("conversations", "ix_conversations_user_update", "(user_id, update_time)"),
    # 启动时的历史数据修复只捞 superseded=1 的行：没索引就是每次开机全表扫一遍聊天记录
    ("chat_messages", "ix_chat_messages_superseded", "(superseded)"),
    # 热路径：某会话 + 未作废 + 按 id 排序（上下文构建、历史分页）
    ("chat_messages", "ix_chat_messages_conv_active_id", "(conversation_id, superseded, id)"),
    # 取本会话最后一条 user / assistant（重新生成、回退、历史修复）
    ("chat_messages", "ix_chat_messages_conv_role_id", "(conversation_id, role, id)"),
)

# 需要在既有表上补的列（表名, 列名, DDL 片段）：create_all 不会改老表结构
COLUMN_MIGRATIONS = (
    ("chat_messages", "superseded", "INT NOT NULL DEFAULT 0"),
    ("chat_messages", "model", "VARCHAR(64) NOT NULL DEFAULT ''"),
    # 用户真正打的字：MySQL 的 TEXT 不能带普通 DEFAULT，只能 NULL（代码里一律 `or ""`）
    ("chat_messages", "question", "TEXT NULL"),
)


def _ensure_columns() -> None:
    """幂等补列：已存在就跳过（老库升级到「可覆盖重新生成」不用手动改表）。"""
    with engine.begin() as conn:
        for table, column, ddl in COLUMN_MIGRATIONS:
            found = conn.execute(
                text(
                    "SELECT COUNT(1) FROM information_schema.columns "
                    "WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column"
                ),
                {"table": table, "column": column},
            ).scalar()
            if not found:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


def _ensure_indexes() -> None:
    """幂等补索引：已存在就跳过，不存在才 CREATE。"""
    with engine.begin() as conn:
        for table, name, columns in INDEX_MIGRATIONS:
            found = conn.execute(
                text(
                    "SELECT COUNT(1) FROM information_schema.statistics "
                    "WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :name"
                ),
                {"table": table, "name": name},
            ).scalar()
            if not found:
                conn.execute(text(f"CREATE INDEX {name} ON {table} {columns}"))


def create_tables() -> None:
    """幂等创建业务表（checkpoint 三表已停写，历史库里的旧表原样冻结保留，不在此处创建或删除）。

    SQLite 只 create_all：information_schema 那套补列补索引是 MySQL 专属写法，
    而新库的结构本来就由模型定义，不存在「老表缺列」。
    """
    SQLModel.metadata.create_all(engine)
    if db_info.db_backend() == db_info.BACKEND_MYSQL:
        _ensure_columns()
        _ensure_indexes()


def is_retryable_lock_error(error: Exception) -> bool:
    """这次失败是不是「等一下就能成」的锁冲突（两种方言各自的判定都收在这里）。

    以前摘要模块直接用字符串 `"database is locked"` 判断，MySQL 的
    1205（lock wait timeout）/1213（deadlock）不匹配，摘要会被当成「不可重试」直接放弃，
    表现为摘要长期不刷新而日志里只有一行 exception。
    """
    raw = f"{getattr(error, 'orig', '')} {error}".lower()
    if "database is locked" in raw or "database table is locked" in raw:
        return True
    code = getattr(getattr(error, "orig", None), "args", ())
    if code and isinstance(code[0], int) and code[0] in (1205, 1213):
        return True
    return "lock wait timeout" in raw or "deadlock" in raw


def probe_detail() -> tuple[bool, str]:
    """连库探活，连不上时把原始异常文本带出来（给诊断工具翻成中文用）。

    健康检查不该因为库抖一下就 500：进程还活着与库能读是两件事，
    调用方（health / 桌面端）需要分开判断，所以 probe() 只回布尔。
    """
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
        return True, ""
    except Exception as error:  # noqa: BLE001
        return False, str(error)


def probe() -> bool:
    """连库探活：任何异常都返回 False。"""
    return probe_detail()[0]
