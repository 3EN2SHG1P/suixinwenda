"""模型层公共片段：SQLite / MySQL 的表参数差异只在这里出现一次。

为什么要有这层：mysql_charset / mysql_collate 是 MySQL 方言专属键。写死在模型里时，
SQLite 现在会静默忽略（不报错），但 Alembic 在 SQLite 上 render_as_batch 重建表
会把这些键一起带进 DDL，产生无意义噪音，也让「同一份模型」在不同库上含义不一致。
"""
from core.db_info import BACKEND_MYSQL, db_backend

MYSQL_TABLE_ARGS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}


def table_args(*extra):
    """拼 __table_args__：只有 MySQL 才追加字符集参数，其余后端原样返回。

    必须支持位置参数：conversation.py 是 `(Index(...), {...})` 的元组形态。
    """
    # 用 db_info 的常量而不是字面量 "mysql"：两处口径分叉时，
    # 「切到 MySQL 但表参数没跟上」只会在建表时安静地少掉字符集声明
    if db_backend() == BACKEND_MYSQL:
        return (*extra, dict(MYSQL_TABLE_ARGS))
    return extra if extra else {}
