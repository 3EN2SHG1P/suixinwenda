"""结构升级：把实际库结构对齐到模型定义（只做增量：补列、补索引）。

为什么不用 Alembic：本项目的结构变更只有「加列 / 加索引」这一种，而它会引入版本表、
模板目录与每次手写的迁移脚本；单机单人维护 5 张表，成本不对等。
为什么连版本号也不记：每次启动都对「实际结构」做对齐，天然幂等——从旧版本升上来、
库被人手改过、装过别人的包，启动时都会收敛回来；版本表反而多一个「记录与实际不一致」的故障点。

这里不做、也做不了的事（写下来免得将来误以为漏了）：
改列类型 / 删列 / 加约束在 SQLite 上都要「建新表 → 拷数据 → 改名」，本模块不覆盖。
真需要的时点再写一次性重建脚本，或那时再引 Alembic（先把当前结构 stamp 成 baseline）。
"""
import hashlib
import logging

from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import SQLModel

from core import backup
from core.database import COLUMN_MIGRATIONS, INDEX_MIGRATIONS, engine

logger = logging.getLogger(__name__)

# 补列/补索引清单的唯一源在 core/database.py：启动路径走本模块（两种方言都覆盖），
# tools/restore.py 走 database.create_tables()（MySQL 专属分支）。两份清单各自维护时，
# 「正常升级出来的库」与「恢复出来的库」结构会悄悄分叉，所以这里只引用不重写。


def _missing_columns(inspector) -> list[tuple[str, str, str]]:
    tables = set(inspector.get_table_names())
    missing = []
    for table, column, ddl in COLUMN_MIGRATIONS:
        if table not in tables:
            continue  # create_all 刚建的新表，列必然齐
        existing = {item["name"] for item in inspector.get_columns(table)}
        if column not in existing:
            missing.append((table, column, ddl))
    return missing


def _missing_indexes(inspector) -> list[tuple[str, str, str]]:
    tables = set(inspector.get_table_names())
    missing = []
    for table, name, columns in INDEX_MIGRATIONS:
        if table not in tables:
            continue
        existing = {item["name"] for item in inspector.get_indexes(table)}
        if name not in existing:
            missing.append((table, name, columns))
    return missing


def schema_fingerprint() -> str:
    """结构指纹：写进启动日志，便于「升级后哪里不对」时判断库结构有没有被动过。"""
    inspector = inspect(engine)
    parts = []
    for table in sorted(inspector.get_table_names()):
        columns = ",".join(sorted(item["name"] for item in inspector.get_columns(table)))
        indexes = ",".join(sorted(item["name"] for item in inspector.get_indexes(table)))
        parts.append(f"{table}[{columns}]({indexes})")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:12]


def upgrade() -> dict:
    """把结构对齐到模型。返回 {'columns': 补了几列, 'indexes': 补了几个索引, 'backup': 快照路径}。"""
    SQLModel.metadata.create_all(engine)
    inspector = inspect(engine)
    columns = _missing_columns(inspector)
    indexes = _missing_indexes(inspector)
    if not columns and not indexes:
        return {"columns": 0, "indexes": 0, "backup": ""}

    # 动结构之前先留快照：加列本身安全，但「在用户真实库上执行 DDL」不该没有退路。
    # 备份失败直接抛——宁可这次不升级，也不要在没有退路的库上改结构。
    # 备份本身不依赖 mysqldump（MySQL 侧有内置导出兜底），所以这里不需要「跳过备份」的开关。
    snapshot = str(backup.create_timestamped_backup())
    logger.info("结构升级前已备份：%s", snapshot)

    return {
        "columns": _apply_columns(columns),
        "indexes": _apply_indexes(indexes),
        "backup": str(snapshot),
    }


# 「已经补过」这一类错误要当成功：Electron 与 start.ps1 同时启动时两边都会尝试同一条 DDL。
# 其它错误（磁盘满、权限不足、锁超时）绝不能吞：吞掉的结果是服务带着缺列/缺索引的库继续跑，
# 之后每次查 chat_messages 都是 500，而日志里只有一行 warning。
_ALREADY_THERE = ("duplicate column", "duplicate key name", "already exists", "duplicate column name")


def _is_already_there(error: SQLAlchemyError) -> bool:
    return any(token in str(error.orig or error).lower() for token in _ALREADY_THERE)


def _apply_columns(columns: list[tuple[str, str, str]]) -> int:
    applied = 0
    for table, column, ddl in columns:
        try:
            # 每条 DDL 独立事务：MySQL 的 DDL 隐式提交，包在一个事务里反而会留下半截状态
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            applied += 1
            logger.info("补列：%s.%s", table, column)
        except SQLAlchemyError as error:
            if not _is_already_there(error):
                raise
            logger.warning("补列失败（可能已被其它进程补上）：%s.%s", table, column)
    return applied


def _apply_indexes(indexes: list[tuple[str, str, str]]) -> int:
    applied = 0
    for table, name, columns in indexes:
        try:
            with engine.begin() as conn:
                conn.execute(text(f"CREATE INDEX {name} ON {table} {columns}"))
            applied += 1
            logger.info("补索引：%s", name)
        except SQLAlchemyError as error:
            if not _is_already_there(error):
                raise
            logger.warning("补索引失败（可能已存在）：%s", name)
    return applied
