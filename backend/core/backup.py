"""一致性备份：数据库快照 + 当前后端的附件目录，打成一个 zip。

为什么不能直接复制 .db：SQLite 在 WAL 模式下，未 checkpoint 的事务还在 -wal 文件里，
只拷主文件会得到一份「少最后几笔」的库。VACUUM INTO 会写出一份完整一致的快照。
MySQL 侧同理，只能交给 mysqldump --single-transaction。
"""
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

from sqlalchemy import text

from core import db_info
from core.attachments import upload_dir

logger = logging.getLogger(__name__)

# 结构升级前会自动备份：只留最近几份，否则每加一列就在用户磁盘上留一个几十 MB 的包
KEEP_BACKUPS = 5

# 只备份业务表（取值与 tools/export.py 的 TABLES 一致，两处必须同源）。
# 老 MySQL 库里另有 4 张已停用的 LangGraph checkpoint 表：实测 139MB / 141MB，
# 备份体积的 98% 是没人用的死表；更糟的是 _sql_literal 把 bytes 写成 `b'...'` 文本，
# 这些表即使恢复也全是静默损坏的垃圾。白名单是唯一规避手段。
TABLES = ("users", "conversations", "chat_messages", "chat_attachments", "chat_summaries")
# 恢复提示随包走：半年后打开这个 zip 的人只能看到这份 manifest
RESTORE_HINT = "数据库请用 mysql <库名> < suixinwenda.sql 一次性执行（sql_mode 只在本次会话生效）"


def backup_dir() -> Path:
    """备份目录：与数据库同在一个 DATA_DIR 下，便于整目录搬走。"""
    return db_info.data_dir() / "backups"


def _skipped_tables(present: list[str], included: list[str]) -> list[str]:
    """这次没进备份的表：库里有但不在白名单的（历史表）+ 白名单里但库里没有的（老库缺表）。

    缺表也算「跳过」：只看 skipped_tables 的人必须能看出「这次没覆盖 chat_summaries」，
    否则一个缺表的备份看起来毫无异常。
    """
    return sorted((set(present) - set(included)) | (set(TABLES) - set(included)))


def _sqlite_tables(path: Path) -> list[str]:
    """列出库里的业务表名（跳过 SQLite 自己的 sqlite_* 内部表）。

    必须显式 close：`with sqlite3.connect(...)` 只管事务，不关连接；
    Windows 上没关的连接会一直锁着文件，临时目录清理时报 WinError 32。
    """
    conn = sqlite3.connect(path)
    try:
        return [
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
    finally:
        conn.close()


def _sqlite_snapshot(target: Path) -> tuple[list[str], list[str]]:
    """整库快照后裁掉白名单外的表，返回（保留的表, 跳过的表）。

    VACUUM INTO 只能整库复制、选不了表，所以快照生成后再删：
    从 MySQL 迁过来的老 SQLite 库同样可能带 checkpoint 那几张死表，
    只改 MySQL 侧等于一半没改。
    """
    # VACUUM INTO 要求目标文件不存在，先清掉上一次的残留
    target.unlink(missing_ok=True)
    source = sqlite3.connect(db_info.sqlite_path())
    try:
        source.execute("VACUUM INTO ?", (str(target),))
    finally:
        source.close()

    snapshot = sqlite3.connect(target)
    try:
        # isolation_level=None 才是 autocommit：默认 legacy 事务语义下
        # VACUUM 会被当成「事务内执行」直接报 cannot VACUUM from within a transaction
        snapshot.isolation_level = None
        present = _sqlite_tables(target)
        included = [name for name in TABLES if name in present]
        skipped = _skipped_tables(present, included)
        for name in skipped:
            # 表名来自 sqlite_master，不是外部输入；双引号包起来防止关键字冲突
            snapshot.execute(f'DROP TABLE IF EXISTS "{name}"')
        snapshot.execute("VACUUM")  # 把删表腾出的页真正释放掉，体积才降得下来
    finally:
        snapshot.close()
    return included, skipped


def _sql_literal(value) -> str:
    """把 Python 值转成 SQL 字面量。

    dump 头部统一 `SET sql_mode='NO_BACKSLASH_ESCAPES'`，所以字符串只需双写单引号，
    不用再处理反斜杠转义——两种转义规则混用是这类导出最典型的出错点。
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def _dump_rows(conn, table: str, handle, chunk: int = 200) -> None:
    columns = [row[0] for row in conn.execute(text(f"SHOW COLUMNS FROM `{table}`"))]
    column_sql = ", ".join(f"`{name}`" for name in columns)
    buffer: list[str] = []

    def flush() -> None:
        if not buffer:
            return
        handle.write(f"INSERT INTO `{table}` ({column_sql}) VALUES\n")
        handle.write(",\n".join(buffer))
        handle.write(";\n")
        buffer.clear()

    for row in conn.execution_options(stream_results=True).execute(
        text(f"SELECT * FROM `{table}`")
    ):
        buffer.append("(" + ", ".join(_sql_literal(value) for value in row) + ")")
        if len(buffer) >= chunk:
            flush()
    flush()
    handle.write("\n")


def _mysql_present_tables() -> list[str]:
    """库中实际存在的表。

    为什么不直接遍历白名单：老库可能压根没建 chat_summaries，
    SHOW CREATE TABLE 会直接报错，备份就整体失败。
    """
    from core.database import engine

    with engine.connect() as conn:
        return [row[0] for row in conn.execute(text("SHOW TABLES"))]


def _mysql_dump_builtin(target: Path, tables: list[str]) -> None:
    """不依赖 mysqldump 的兜底导出：SHOW CREATE TABLE + 分批 INSERT。

    机器上没装 MySQL 客户端时，与其让用户去装一整套 MySQL，不如用几张表的
    SHOW CREATE TABLE 自己拼一份可恢复的 SQL——格式简单、可控、出错面小。

    必须在同一个事务里读所有表：否则用户边用边备份时，chat_messages 可能比
    conversations 新，导出的是一份「时间点不一致」的数据（mysqldump 靠
    --single-transaction 解决的就是这件事）。InnoDB 默认 REPEATABLE READ，
    事务内第一次 SELECT 就定住快照，之后所有表读的都是那一刻。
    """
    from core.database import engine

    with engine.connect() as conn:
        transaction = conn.begin()
        try:
            with target.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write("-- 随心问答内置导出（未使用 mysqldump）\n")
                handle.write("SET sql_mode='NO_BACKSLASH_ESCAPES';\n\n")
                for table in tables:
                    (ddl,) = conn.execute(text(f"SHOW CREATE TABLE `{table}`")).one()[1:]
                    handle.write(f"DROP TABLE IF EXISTS `{table}`;\n{ddl};\n\n")
                    _dump_rows(conn, table, handle)
        finally:
            # 只读事务，回滚结束即可（不写库）
            transaction.rollback()


def _mysqldump(target: Path, tables: list[str]) -> None:
    env = dict(os.environ)
    # 口令走环境变量而不是命令行：命令行参数在本机任何进程列表里都看得见
    env["MYSQL_PWD"] = os.environ.get("DB_PASSWORD", "")
    # 必须跳过存储过程与触发器：--routines 仍会导出全库存储过程，
    # 产物里会出现 `DELIMITER ;;` 块——那是 mysql 客户端指令，恢复时用
    # CLIENT.MULTI_STATEMENTS 执行必然语法错误
    command = [
        "mysqldump",
        "--single-transaction",
        "--skip-routines",
        "--skip-triggers",
        "--default-character-set=utf8mb4",
        "--result-file",
        str(target),
        "-h",
        os.environ.get("DB_HOST", "127.0.0.1"),
        "-P",
        os.environ.get("DB_PORT", "3306"),
        "-u",
        os.environ.get("DB_USER", "root"),
        os.environ.get("DB_NAME", ""),
        # 表名放在库名之后：没有表名参数时 mysqldump 会导出整个库
        *tables,
    ]
    # 必须带 timeout：库卡在元数据锁或网络半开时，mysqldump 会一直不返回，
    # 同步调用会把请求线程（含线程池名额）永久占住
    result = subprocess.run(
        command, env=env, capture_output=True, text=True, check=False, timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(f"mysqldump 失败：{(result.stderr or '').strip()[:300]}")


def _mysql_dump(target: Path) -> tuple[str, list[str], list[str]]:
    """优先 mysqldump，没有就内置导出。返回（方式, 保留的表, 跳过的表）。"""
    # 表集合在连接里先取一次：它决定了本次要导哪几张表，与后端的读取事务无关
    present = _mysql_present_tables()
    included = [name for name in TABLES if name in present]
    skipped = _skipped_tables(present, included)
    target.unlink(missing_ok=True)
    if not included:
        # 空库：一张业务表都没有。绝不能调 mysqldump——不给表名参数它会导出整库，
        # 好不容易排除掉的 4 张死表又被带回来（这条路径在首次启动前备份时才会出现）
        target.write_text(
            "-- 随心问答备份：当前库里没有任何业务表\nSET sql_mode='NO_BACKSLASH_ESCAPES';\n",
            encoding="utf-8",
        )
        return "empty", included, skipped
    if shutil.which("mysqldump"):
        _mysqldump(target, included)
        return "mysqldump", included, skipped
    logger.warning("未找到 mysqldump，改用内置导出（生成的是标准 SQL，同样可恢复）")
    _mysql_dump_builtin(target, included)
    return "builtin", included, skipped


def create_backup(out_path: Path) -> dict:
    """把数据库快照与附件写进 out_path（zip）。返回 {'db', 'files', 'backend', ...}。"""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    backend = db_info.db_backend()
    attachments = upload_dir()

    with tempfile.TemporaryDirectory(prefix="suixinwenda-backup-") as tmp:
        dump = Path(tmp) / ("suixinwenda.db" if backend == db_info.BACKEND_SQLITE else "suixinwenda.sql")
        if backend == db_info.BACKEND_SQLITE:
            included, skipped = _sqlite_snapshot(dump)
            dump_method = "vacuum"
        else:
            dump_method, included, skipped = _mysql_dump(dump)
        db_entry = f"db/{dump.name}"

        file_count = 0
        # 先写 .part 再原子改名：中途失败（附件被删/磁盘满）不会在最终文件名上留下半截 zip。
        # 半截包比没有包更危险——prune_backups 会把它当有效备份计数，挤掉真正的回滚点
        part_path = out_path.with_name(f"{out_path.name}.part")
        part_path.unlink(missing_ok=True)
        try:
            with zipfile.ZipFile(part_path, "w", zipfile.ZIP_DEFLATED) as bundle:
                bundle.write(dump, arcname=db_entry)
                if attachments.exists():
                    for item in attachments.rglob("*"):
                        if item.is_file():
                            bundle.write(
                                item, arcname=f"uploads/{item.relative_to(attachments).as_posix()}"
                            )
                            file_count += 1
                # manifest 说明「附件该还原到哪个后端目录」：少了它，半年后打开这个 zip
                # 没人知道 uploads/ 里那堆文件属于 sqlite 还是 mysql
                #
                # 表清单字段叫 included_tables / skipped_tables，不能叫 tables：
                # 导出侧（tools/export.py）的同名字段是 {表名: {rows, sha256}} 对象，
                # 同名不同形会让恢复端把两边的 manifest 当成同一种东西解析。
                bundle.writestr(
                    "manifest.json",
                    json.dumps(
                        {
                            "backend": backend,
                            # 库身份（含 host/port/name）：恢复时能看出这份包属于哪个 MySQL 库。
                            # backend 字段保留 sqlite/mysql 语义，恢复端的分支判断依赖它
                            "scope": db_info.storage_scope(),
                            "created_at": int(time.time()),
                            "db": db_entry,
                            "dump_method": dump_method,
                            "attachment_root": f"data/uploads/{db_info.storage_scope()}",
                            "attachment_files": file_count,
                            "included_tables": included,
                            "skipped_tables": skipped,
                            "restore_hint": RESTORE_HINT,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                )
            os.replace(part_path, out_path)
        finally:
            # 失败路径的残留：改成 .part 后不影响正式文件，但也没必要留在磁盘上
            try:
                part_path.unlink(missing_ok=True)
            except OSError:
                logger.debug("清理未完成的备份临时文件失败：%s", part_path, exc_info=True)
    return {
        "db": db_entry,
        "files": file_count,
        "backend": backend,
        "dump_method": dump_method,
        "included_tables": included,
        "skipped_tables": skipped,
    }


def prune_backups(
    keep: int = KEEP_BACKUPS, backend: str | None = None, prefix: str | None = None
) -> int:
    """只留最近 keep 份备份，返回删除个数。

    backend 不为空时只清理该后端的包：SQLite 与 MySQL 的自动备份共用同一个目录，
    不分开的话两边会互相把对方的 5 份配额挤掉。

    prefix 不为空时只清理该前缀的包：升级前备份（before-upgrade）与恢复前备份
    （before-restore）必须各自一池。共用配额的话，多恢复几次就会把「回滚升级」
    的那份挤掉，等真出问题时已经没得退了。
    """
    root = backup_dir()
    if not root.exists():
        return 0
    candidates = list(root.glob("*.zip"))
    if backend:
        candidates = [item for item in candidates if f"-{backend}-" in item.name]
    if prefix:
        candidates = [item for item in candidates if item.name.startswith(f"{prefix}-")]
    files = sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True)
    removed = 0
    for old in files[keep:]:
        try:
            old.unlink()
            removed += 1
        except OSError:
            # 删不掉不影响本次升级，下次再试
            continue
    return removed


def timestamped_backup_path(prefix: str) -> Path:
    """自动备份的落点：前缀-库身份-本地时间戳。

    用 storage_scope 而不是只有 sqlite/mysql：本地 MySQL 与远程 MySQL 的包混在一起时，
    「各留 5 份」会互相挤占；名字里带上库身份，既分池又能一眼认出是哪个库的包。
    """
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return backup_dir() / f"{prefix}-{db_info.storage_scope()}-{stamp}.zip"


def create_timestamped_backup_with_detail(prefix: str = "before-upgrade") -> tuple[Path, dict]:
    """生成一份自动备份并返回 (路径, create_backup 的明细)。

    明细给 tools/backup.py 用：界面上的「自动备份」也要能显示导了几张表、几个附件，
    但 create_timestamped_backup 的历史调用方（结构升级）只关心路径，所以保留原签名。
    """
    target = timestamped_backup_path(prefix)
    detail = create_backup(target)
    # 只清理同前缀、同库身份的旧包：三种前缀（升级前 / 恢复前 / 定期）各有一池配额，
    # 本地 MySQL 与远程 MySQL 也不再互相挤占
    prune_backups(backend=db_info.storage_scope(), prefix=prefix)
    return target, detail


def create_timestamped_backup(prefix: str = "before-upgrade") -> Path:
    """自动备份（只要路径）：文件名带前缀、后端名与时间戳，写完只清理同前缀同后端的旧包。"""
    return create_timestamped_backup_with_detail(prefix)[0]
