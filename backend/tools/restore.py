"""从备份 zip 或导出目录恢复数据（备份的入口，与 tools/backup.py 对称）。

支持的三种来源，靠包内结构判别，不看扩展名：
1. 导出目录（manifest.json + users.jsonl）——JSONL，不含附件
2. 备份 zip 且含 db/suixinwenda.db——SQLite 快照
3. 备份 zip 且含 db/suixinwenda.sql——MySQL 脚本（只能在 MySQL 后端上恢复）

为什么做成独立工具而不是接口：恢复要么清空整库、要么 DROP TABLE，
被任何一个 HTTP 请求顺带触发都是灾难；桌面端会先停掉托管的后端再跑本工具。
输出同样是一行 JSON：成功带各表行数与恢复前的备份路径，失败带中文原因与阶段。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from sqlalchemy import func, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from core import db_info
from core.attachments import upload_dir, write_atomic
from core.backup import create_timestamped_backup
from core.database import create_tables, engine
from models import ChatAttachment, ChatMessage, ChatSummary, Conversation, User
from tools import emit, purge

SOURCE_EXPORT = "export"
SOURCE_SQLITE = "sqlite"
SOURCE_MYSQL = "mysql"

# 恢复时解压附件的总量上限（按 zip 里声明的大小累加）：
# 没有上限时一个几十 KB、压缩比极高的包就能写满系统盘，且发生在清库之后
MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024

# 写入顺序：users → conversations → 三张子表。
# 模型层没有任何 FOREIGN KEY，这个顺序不是「绕开外键」，而是让
# chat_messages.conversation_id / chat_attachments.message_id / chat_summaries.conversation_id
# 这些裸 int 逻辑关联在写完后能自洽，也便于逐表核对行数。
MODELS = {
    "users": User,
    "conversations": Conversation,
    "chat_messages": ChatMessage,
    "chat_attachments": ChatAttachment,
    "chat_summaries": ChatSummary,
}
TABLES = tuple(MODELS)
# 判断「目标库是否已有数据」只看这 4 张：users 不计入——
# purge_all() 本来就不删账号，把 users 算进来会让「一键清除」之后依然非空，提示的解法恒无效
SESSION_TABLES = ("conversations", "chat_messages", "chat_attachments", "chat_summaries")
# 停用的 LangGraph 历史表：存量备份里一定带着它们（内置导出以前是全表导）
LEGACY_PREFIX = "checkpoint"

# 备份包内的数据库条目名（唯一来源）：写入与读取都用这一个名字
DB_MEMBER_SQLITE = "db/suixinwenda.db"
DB_MEMBER_MYSQL = "db/suixinwenda.sql"

# 从 SQL 脚本里认表名：内置导出与 mysqldump 都只用这三种语句操作业务表
_TABLE_REF = re.compile(
    r"(?:DROP\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INSERT\s+INTO)"
    r"\s+`?([A-Za-z0-9_$]+)`?",
    re.IGNORECASE,
)


class RestoreError(RuntimeError):
    """可以直接展示给用户的中文错误（main 会把 str(error) 原样放进 JSON）。"""


def _zip_members(bundle: zipfile.ZipFile) -> set[str]:
    """包内全部条目名（已做路径校验，越界条目在这里就会抛错）。"""
    return {_member_name(info) for info in bundle.infolist()}


def _db_member(names: set[str], primary: str) -> str | None:
    """在包内条目里找数据库文件（只认唯一成员名）。"""
    return primary if primary in names else None


def detect_source(path: Path) -> str:
    """判断来源类型；不是随心问答的产物就报中文错误。"""
    if path.is_dir():
        if (path / "manifest.json").is_file() and (path / "users.jsonl").is_file():
            return SOURCE_EXPORT
        raise RestoreError("这不是随心问答的备份或导出目录")
    if path.is_file() and zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as bundle:
            # 先整体校验包内路径：等到解附件时才撞上 `..`，前面的备份与清空已经做完了
            names = _zip_members(bundle)
            if _db_member(names, DB_MEMBER_SQLITE):
                return SOURCE_SQLITE
            if _db_member(names, DB_MEMBER_MYSQL):
                return SOURCE_MYSQL
    raise RestoreError("这不是随心问答的备份或导出目录")


def _member_name(info: zipfile.ZipInfo) -> str:
    """校验并规范化包内的相对路径；任何越界形态直接拒绝。

    zip 里的名字是攻击面：`../x` 与 `C:/Windows/x` 都能让「解压到临时目录」写到目录外。
    """
    name = str(info.filename).replace("\\", "/")
    if not name or name.startswith("/"):
        raise RestoreError(f"备份包里有非法路径：{info.filename}")
    if len(name) > 1 and name[1] == ":":
        raise RestoreError(f"备份包里有非法路径：{info.filename}")
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if ".." in parts:
        raise RestoreError(f"备份包里有非法路径：{info.filename}")
    return "/".join(parts)


def read_export_dir(path: Path) -> dict:
    """读导出目录：每个 .jsonl 先用 manifest 里的 sha256 校验，再逐行解析。"""
    try:
        manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RestoreError(f"导出目录里的 manifest.json 读不了：{error}") from error
    meta = manifest.get("tables") if isinstance(manifest.get("tables"), dict) else {}

    rows: dict[str, list[dict]] = {}
    for table in TABLES:
        source = path / f"{table}.jsonl"
        if not source.is_file():
            continue
        data = source.read_bytes()
        item = meta.get(table)
        expected = item.get("sha256") if isinstance(item, dict) else None
        # sha256 是逐行累积写出来的，等于整个文件的哈希：不一致说明文件被改过或没写完
        if expected and hashlib.sha256(data).hexdigest() != expected:
            raise RestoreError(f"{table}.jsonl 校验不一致，导出文件可能已损坏")
        try:
            rows[table] = [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]
        except (UnicodeDecodeError, ValueError) as error:
            raise RestoreError(f"{table}.jsonl 内容损坏：{error}") from error
    if not rows:
        raise RestoreError("导出目录里没有任何表的数据文件")
    return rows


def read_sqlite_backup(db_path: Path) -> dict:
    """只读打开备份里的 .db，逐表读成 dict。

    备份可能是老版本的库（缺 superseded / model / question 列）：这里只按
    「库里实际有什么」读，列与目标表的交集由 restore_into 统一过滤。
    """
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        present = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        rows: dict[str, list[dict]] = {}
        for table in TABLES:
            if table not in present:
                continue
            rows[table] = [dict(row) for row in conn.execute(f'SELECT * FROM "{table}"')]
        return rows
    finally:
        conn.close()


def validate_sql_tables(sql: str) -> list[str]:
    """校验 SQL 里出现的表名，返回其中的历史表（checkpoint*）。

    白名单 = 5 张业务表 + 表名以 checkpoint 开头的表：
    存量备份一定含那 4 张停用的表，只放行 5 张会把用户手上每一份旧包判成非法。
    历史表照常执行、不跳过——跳过就得按 DROP TABLE 切语句块（mysqldump 带 /*!40101 */ 注释，
    切不干净），引入新 bug 的风险比「多建几张内容错误的死表」大得多。
    """
    _validate_sql_statements(sql)
    seen = sorted({match.group(1) for match in _TABLE_REF.finditer(sql)})
    unknown = [name for name in seen if name not in TABLES and not name.startswith(LEGACY_PREFIX)]
    if unknown:
        raise RestoreError(f"备份里出现了不是随心问答的表：{'、'.join(unknown)}，已拒绝执行")
    if not any(name in TABLES for name in seen):
        raise RestoreError("这不是随心问答的备份：SQL 里没有任何业务表")
    return [name for name in seen if name.startswith(LEGACY_PREFIX)]


# 允许出现在备份 SQL 里的「语句开头」：mysqldump 只会产出这几类，
# 以及版本注释（/*!40101 ... */）与行注释。校验与执行必须用同一个切分函数，
# 切分口径一旦分叉，一个 `DROP DATABASE` / `SELECT ... INTO OUTFILE` 就足以毁库或写文件
_ALLOWED_SQL_PREFIXES = (
    # 注意不能把空串放进元组：startswith("") 恒为 True，等于白名单失效
    "--",
    "/*",
    "SET ",
    "DROP TABLE",
    "CREATE TABLE",
    "INSERT INTO",
    "LOCK TABLES",
    "UNLOCK TABLES",
    "ALTER TABLE",
    "START TRANSACTION",
    "COMMIT",
    "USE ",
)


def _split_statements(sql: str) -> list[str]:
    """按「行尾分号」切语句，返回每条待执行的语句。

    为什么按行尾而不是按 `;`：mysqldump 的每条语句都以 `;` 结束并独占行尾，
    而字符串字面量里的分号不会出现在行尾。校验与执行共用本函数是硬约束：
    两处切法不同时，攻击者只要让「校验看到的第一条」与「执行看到的第一条」不同，
    就能把第二条语句（`DROP DATABASE`）送进 MULTI_STATEMENTS。

    字符串里出现「`;` + 换行」时会误切，但误切的后果是后半段不以白名单开头被拒绝，
    属于失败关闭，不会放过危险语句。
    """
    statements: list[str] = []
    buffer: list[str] = []
    for line in sql.splitlines():
        buffer.append(line)
        if line.rstrip().endswith(";"):
            chunk = "\n".join(buffer).strip()
            if chunk:
                statements.append(chunk)
            buffer = []
    tail = "\n".join(buffer).strip()
    if tail:
        statements.append(tail)
    return statements


def _validate_sql_statements(sql: str) -> None:
    """逐条检查语句开头；出现白名单之外的语句直接拒绝，不做「尽力执行」。"""
    for statement in _split_statements(sql):
        upper = statement.upper()
        if not upper.startswith(_ALLOWED_SQL_PREFIXES):
            head = " ".join(upper.split()[:2])
            raise RestoreError(
                f"备份 SQL 里含不允许的语句（{head}），已拒绝执行："
                "只接受建表 / 插入数据这类恢复语句"
            )


def _read_mysql_script(bundle: zipfile.ZipFile) -> tuple[str, list[str]]:
    member = _db_member(_zip_members(bundle), DB_MEMBER_MYSQL) or DB_MEMBER_MYSQL
    with bundle.open(member) as source:
        raw = source.read()
    try:
        sql = raw.decode("utf-8")
    except UnicodeDecodeError:
        # 少数客户端导出的是本地编码。绝不能用 errors="replace"：
        # 那样「恢复成功」但所有中文静默变成 U+FFFD，用户只能看到一个全乱码的库
        try:
            sql = raw.decode("gb18030")
        except UnicodeDecodeError as exc:
            raise RestoreError(
                "备份里的 SQL 既不是 UTF-8 也不是 GB18030，无法安全恢复；"
                "请用 utf8mb4 重新导出后再试"
            ) from exc
    return sql, validate_sql_tables(sql)


def _extract_attachments(bundle: zipfile.ZipFile, tmp: Path) -> list[tuple[str, int, Path]]:
    """把 uploads/ 下的文件解到临时目录，返回（相对 uploads 的路径, 声明大小, 临时文件）。

    绝不 extractall：它不看名字，一个 `../` 就能写到目录外。
    另外两道闸：声明总量超过上限直接拒绝（几十 KB 的包可以解出几十 GB），
    单个条目的名字必须是普通的相对路径（_member_name 已挡 `..` 与盘符）。
    """
    root = tmp / "uploads"
    entries: list[tuple[str, int, Path]] = []
    total = 0
    for info in bundle.infolist():
        if info.is_dir():
            continue
        name = _member_name(info)
        if not name.startswith("uploads/"):
            continue
        rel = name[len("uploads/") :]
        if not rel:
            continue
        total += int(info.file_size)
        if total > MAX_RESTORE_BYTES:
            raise RestoreError(
                f"备份里的附件超过 {MAX_RESTORE_BYTES // (1024 * 1024 * 1024)} GB，已拒绝解压"
            )
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with bundle.open(info) as source, target.open("wb") as handle:
            shutil.copyfileobj(source, handle)
        entries.append((rel, int(info.file_size), target))
    return entries


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def place_attachments(entries: list[tuple[str, int, Path]]) -> dict:
    """把临时目录里的附件落到当前后端的附件根（幂等）。

    目标已存在同名文件：**大小和 sha256 都一致**才复用（同 sha 的图很常见）。
    只比大小是不够的：大小相同内容不同的文件会被当成同一份，恢复后图片/文档静默变成错的。
    不一致就报错而不是覆盖——静默覆盖等于把用户现有的一张图换成别的图，且无从发现。
    """
    root = upload_dir()
    written = 0
    reused = 0
    for rel, size, source in entries:
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            local = target.stat().st_size
            if local == size and _sha256_of(target) == _sha256_of(source):
                reused += 1
                continue
            raise RestoreError(
                f"附件冲突：{rel} 已存在且内容不一致（本地 {local} 字节，备份 {size} 字节），未覆盖"
            )
        write_atomic(target, source.read_bytes())
        written += 1
    return {"written": written, "reused": reused}


def drop_unreferenced_files() -> int:
    """删掉附件目录里没有被任何 chat_attachments 行引用的文件，返回删除数。

    只在 --force 恢复成功后调用：此时库是备份的镜像，旧会话的附件再也没有引用，
    留着只是占磁盘（不靠启动时的 7 天孤儿清理，是因为用户明确要求「替换成这份数据」）。
    绝不能放在落附件之前：会把刚写进来的那批一起删掉。
    """
    with Session(engine) as session:
        referenced = {
            str(row.stored_path)
            for row in session.exec(select(ChatAttachment)).all()
            if row.stored_path
        }
    root = upload_dir()
    if not root.exists():
        return 0
    removed = 0
    for item in root.rglob("*"):
        if not item.is_file():
            continue
        rel = item.relative_to(root).as_posix()
        if rel in referenced:
            continue
        try:
            item.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def count_missing_attachments() -> int:
    """统计「库里有引用、磁盘上没文件」的附件数。

    导出目录本身不带附件；只恢复导出目录（未指定 --uploads-from）时，
    历史里每张图/文档都会点开 404，但恢复过程一切正常。
    把这个数字回给界面，用户才知道下一步该补哪份备份。
    """
    with Session(engine) as session:
        paths = {
            str(row.stored_path)
            for row in session.exec(select(ChatAttachment)).all()
            if row.stored_path
        }
    root = upload_dir()
    return sum(1 for rel in paths if not (root / rel).exists())


def _target_columns(engine) -> dict[str, set[str]]:
    """目标库每张表的实际列集合：按它过滤源数据，未知列丢弃、缺失列走模型默认值。"""
    inspector = inspect(engine)
    return {table: {item["name"] for item in inspector.get_columns(table)} for table in TABLES}


def _session_counts(session: Session) -> dict:
    return {
        table: int(session.execute(select(func.count()).select_from(MODELS[table])).scalar_one() or 0)
        for table in TABLES
    }


def _merge_users(session: Session, rows: list[dict], columns: set[str]) -> tuple[dict, int, int]:
    """按 username 合并账号，返回（源 id → 目标 id 的映射, 复用数, 新增数）。

    为什么不按 id 硬插：--force 之后 users 是保留的，硬插会撞主键；
    按 username 复用还能保证「一键清除保留账号」之后，恢复回来的会话仍然挂在原来那个人身上。
    已存在的账号不覆盖任何字段——密码与创建时间以目标库为准，
    否则恢复一份旧备份就等于把用户后来改过的密码退回去。
    """
    current = session.exec(select(User)).all()
    existing = {row.username: int(row.id) for row in current}
    id_owner = {int(row.id): row.username for row in current}
    mapping: dict[int, int] = {}
    merged = 0
    inserted = 0
    for raw in rows:
        payload = {key: value for key, value in raw.items() if key in columns}
        username = str(payload.get("username") or "").strip()
        if not username:
            raise RestoreError("备份里的账号缺少 username，无法合并")
        source_id = payload.get("id")
        if username in existing:
            if source_id is not None:
                mapping[int(source_id)] = existing[username]
            merged += 1
            continue
        if source_id is not None:
            owner = id_owner.get(int(source_id))
            if owner is not None and owner != username:
                # 猜一个空闲 id 会让会话挂到别人名下，宁可不恢复
                raise RestoreError(
                    f"账号 id {source_id} 在目标库已被「{owner}」占用，无法恢复账号「{username}」；"
                    "请先备份后清空账号数据再试"
                )
        user = User(**payload)
        session.add(user)
        session.flush()
        if source_id is not None:
            mapping[int(source_id)] = int(user.id)
        id_owner[int(user.id)] = username
        existing[username] = int(user.id)
        inserted += 1
    return mapping, merged, inserted


def restore_into(engine, rows: dict[str, list[dict]]) -> dict:
    """把行写进目标库（单事务 + 行数核对）。

    engine 由调用方传入：单测要能换成独立临时库，而不是动全局单例。
    """
    columns = _target_columns(engine)
    counts: dict[str, int] = {}
    users_merged = 0
    users_inserted = 0
    try:
        with Session(engine) as session:
            before = _session_counts(session)
            mapping, users_merged, users_inserted = _merge_users(
                session, rows.get("users") or [], columns["users"]
            )
            for table in TABLES[1:]:
                for raw in rows.get(table) or []:
                    payload = {key: value for key, value in raw.items() if key in columns[table]}
                    if table == "conversations" and payload.get("user_id") is not None:
                        # 匿名会话 user_id 为 None，原样保留。
                        # 找不到源账号映射时绝不沿用原 id：目标库里同 id 可能已经是另一个账号，
                        # 那等于把别人的会话挂到他名下（越权可见）。宁可整包恢复失败。
                        original = int(payload["user_id"])
                        mapped = mapping.get(original)
                        if mapped is None:
                            raise RestoreError(
                                f"备份里的会话引用了不存在的账号（id={original}），"
                                "无法确定归属，已拒绝恢复；请确认备份完整后重试"
                            )
                        payload["user_id"] = mapped
                    session.add(MODELS[table](**payload))
            session.flush()

            counts = _session_counts(session)
            for table in SESSION_TABLES:
                want = before[table] + len(rows.get(table) or [])
                if counts[table] != want:
                    raise RestoreError(
                        f"{table} 行数核对失败：期望 {want} 行，实际 {counts[table]} 行，已回滚"
                    )
            session.commit()  # 只有全部核对通过才提交；之前抛异常会自动回滚
    except RestoreError:
        raise
    except SQLAlchemyError as error:
        # 主键冲突（例如 chat_summaries 的 conversation_id 重复）会落到这里：
        # 原始报错是英文 SQL 片段，对用户没有意义
        raise RestoreError(f"写入失败，已回滚：{str(error.orig or error)[:200]}") from error
    # users 的行数已经是 flush 之后的真实值（含合并与新增），不要再加 users_inserted
    return {"counts": counts, "users_merged": users_merged, "users_inserted": users_inserted}


def _ensure_tables() -> None:
    """只在缺表时才建。

    不能无条件 create_tables()：它会建库文件、建空表、跑 _ensure_columns/_ensure_indexes，
    让后面那句「只读检查」变成假话。
    用 create_tables() 而不是 migrations.upgrade()：后者检测到缺列时还会再做一次备份。
    """
    present = set(inspect(engine).get_table_names())
    if any(table not in present for table in TABLES):
        create_tables()


def _session_row_counts() -> dict:
    """只看 4 张会话表（users 不计入，见 SESSION_TABLES 的注释）。"""
    with engine.connect() as conn:
        return {
            table: int(conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() or 0)
            for table in SESSION_TABLES
        }


def _table_counts_all() -> dict:
    present = set(inspect(engine).get_table_names())
    with engine.connect() as conn:
        return {
            table: int(conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() or 0)
            for table in TABLES
            if table in present
        }


# 账号表里「以目标库为准」的字段：恢复旧包不该把用户后来改过的密码退回去
USER_FIELDS = ("username", "password", "nickname", "avatar", "status", "add_time")


def _snapshot_users() -> dict[str, dict]:
    """执行 SQL 脚本前记下目标库现有账号：脚本里的 DROP/INSERT 会把 users 整表覆盖。"""
    with Session(engine) as session:
        return {
            str(row.username): {name: getattr(row, name) for name in USER_FIELDS}
            for row in session.exec(select(User)).all()
        }


def _reapply_users(snapshot: dict[str, dict]) -> tuple[int, int]:
    """把快照里的账号写回，返回（覆盖回原密码的账号数, 补回的账号数）。

    与 SQLite / 导出目录分支同一口径：已存在的账号一律以「恢复前」的密码与状态为准，
    备份里没有的账号补回来——否则恢复一份旧备份等于把密码退回旧值、并删掉新注册的人。
    """
    if not snapshot:
        return 0, 0
    merged = 0
    restored = 0
    with Session(engine) as session:
        current = {str(row.username): row for row in session.exec(select(User)).all()}
        for username, values in snapshot.items():
            row = current.get(username)
            if row is None:
                # 不带 id 重新插入：备份里可能把这个 id 分配给了别的账号
                session.add(User(**{name: values[name] for name in USER_FIELDS}))
                restored += 1
                continue
            row.password = values["password"]
            row.nickname = values["nickname"]
            row.avatar = values["avatar"]
            row.status = values["status"]
            session.add(row)
            merged += 1
        session.commit()
    return merged, restored


def _execute_mysql_script(sql: str) -> None:
    """按语句逐条交给 MySQL 执行。

    不用 CLIENT.MULTI_STATEMENTS：它会把整包当成「可以含任意条语句」的一段文本，
    而白名单校验只能看到切分开的单条语句，两者口径不同就是绕过点（同一行写
    `INSERT ...; DROP DATABASE` 时校验过、执行也过）。现在校验与执行都走
    `_split_statements`，执行侧只认这一次切分的结果。

    注意 DDL 在 MySQL 里隐式提交：这一分支做不到单事务回滚，
    失败后的保障是「先整包校验 + 用 pre_backup 回灌」。
    """
    import pymysql

    # 与运行时链路同一套安全约束：远程库必须显式放行，且配了 CA 就必须走 TLS。
    # 这里整包是「账号表 + 全部聊天记录」，明文过公网比普通请求更严重
    db_info.validate_remote()
    conn = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", ""),
        charset="utf8mb4",
        autocommit=True,
        **db_info.ssl_connect_args(),
    )
    try:
        with conn.cursor() as cursor:
            for statement in _split_statements(sql):
                cursor.execute(statement)
    finally:
        conn.close()


def run_restore(from_path: Path, uploads_from: Path | None, force: bool, state: dict) -> dict:
    """按「先只读、后写库」的顺序执行恢复。state 里回填 pre_backup 与失败阶段。"""
    state["stage"] = "inspect"
    source = detect_source(from_path)
    if source == SOURCE_MYSQL and db_info.db_backend() != db_info.BACKEND_MYSQL:
        # 不要提示「改用导出 JSONL」：导出要连得上 MySQL，而用户此刻正停在 SQLite
        raise RestoreError(
            "这是 MySQL 备份，当前是 SQLite。请先切到 MySQL 恢复（设置里填连接信息），"
            "或手工 `mysql <库名> < suixinwenda.sql`"
        )
    _ensure_tables()
    if not force:
        used = _session_row_counts()
        if any(used.values()):
            detail = "、".join(f"{name} {value} 行" for name, value in used.items() if value)
            raise RestoreError(
                f"目标库已有会话数据（{detail}）。请先「一键清除」，或加 --force（会先自动备份再清空）"
            )

    with tempfile.TemporaryDirectory(prefix="suixinwenda-restore-") as tmp_dir:
        tmp = Path(tmp_dir)
        rows: dict[str, list[dict]] = {}
        sql_text = ""
        legacy: list[str] = []
        attachments: list[tuple[str, int, Path]] = []

        if from_path.is_file():
            with zipfile.ZipFile(from_path) as bundle:
                if source == SOURCE_SQLITE:
                    db_file = tmp / "db" / "suixinwenda.db"
                    db_file.parent.mkdir(parents=True, exist_ok=True)
                    member = _db_member(_zip_members(bundle), DB_MEMBER_SQLITE) or DB_MEMBER_SQLITE
                    with bundle.open(member) as src, db_file.open("wb") as out:
                        shutil.copyfileobj(src, out)
                    attachments = _extract_attachments(bundle, tmp)
                else:
                    sql_text, legacy = _read_mysql_script(bundle)
                    attachments = _extract_attachments(bundle, tmp)
        if source == SOURCE_SQLITE:
            rows = read_sqlite_backup(tmp / "db" / "suixinwenda.db")
        elif source == SOURCE_EXPORT:
            # 导出不含附件：附件只能来自 --uploads-from 指定的备份包
            rows = read_export_dir(from_path)
            if uploads_from is not None:
                with zipfile.ZipFile(uploads_from) as bundle:
                    attachments = _extract_attachments(bundle, tmp)

        state["stage"] = "backup"
        pre_backup = create_timestamped_backup(prefix="before-restore")
        state["pre_backup"] = str(Path(pre_backup).resolve()) if pre_backup else ""

        # 顺序：先落附件（只增不删，失败时库还是原样）→ 再清库 → 最后写库。
        # 以前是「清库 → 落附件 → 写库」，附件那步一失败就留下一个空库 + 半套附件
        state["stage"] = "files"
        file_stats = place_attachments(attachments)

        try:
            if force:
                state["stage"] = "purge"
                # 附件已在上一步落到目标目录：必须 keep_files，
                # 否则刚写进去的那批会被 purge 一起删掉，恢复完历史里每个附件都 404
                purge.purge_all(keep_files=True)
            state["stage"] = "write"
            if source == SOURCE_MYSQL:
                # SQL 脚本里含 DROP/INSERT users：先记下现有账号，执行完（失败也算）再按口径写回，
                # 这样 MySQL 分支与 SQLite 分支的「账号合并」语义才一致
                snapshot = _snapshot_users()
                try:
                    _execute_mysql_script(sql_text)
                finally:
                    users_merged, users_inserted = _reapply_users(snapshot)
                counts = _table_counts_all()
            else:
                result = restore_into(engine, rows)
                counts = result["counts"]
                users_merged = result["users_merged"]
                users_inserted = result["users_inserted"]
            if force:
                # 写库成功后才清旧附件：库已是备份的镜像，没被引用的文件就是旧会话留下的
                state["stage"] = "cleanup"
                drop_unreferenced_files()
        except Exception as error:  # noqa: BLE001
            # 清库之后任何失败都必须把「退路在哪」写进错误里：
            # 这是用户唯一能自己救回来的信息
            backup_hint = state.get("pre_backup") or "（未生成）"
            raise RestoreError(
                f"{error}\n目标库可能已被清空；恢复前的备份：{backup_hint}，可用它重新恢复"
            ) from error

    missing = count_missing_attachments()
    payload = {
        "source": "export" if source == SOURCE_EXPORT else "zip",
        "tables": counts,
        "files": file_stats["written"] + file_stats["reused"],
        "pre_backup": state["pre_backup"],
        "users_merged": users_merged,
        "users_inserted": users_inserted,
        "legacy_tables": legacy,
        "missing_attachments": missing,
    }
    if missing:
        # 界面已经有 output.warning 的展示位：这里给一句可操作的中文，而不是让用户逐条点开 404
        payload["warning"] = (
            f"有 {missing} 个附件文件没找到（导出目录不含附件）："
            "历史里这些附件点开会提示文件不存在；如需补齐，请改用备份 zip 或指定附件来源"
        )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="从备份 zip 或导出目录恢复数据")
    parser.add_argument("--from", dest="source", required=True, help="备份 zip 或导出目录")
    parser.add_argument("--uploads-from", dest="uploads_from", default="", help="附件来源（备份 zip）")
    parser.add_argument("--force", action="store_true", help="目标库非空时先自动备份再清空")
    args = parser.parse_args()

    state = {"pre_backup": "", "stage": "inspect"}
    try:
        payload = run_restore(
            Path(args.source),
            Path(args.uploads_from) if args.uploads_from else None,
            bool(args.force),
            state,
        )
        emit({"ok": True, **payload})
    except Exception as error:  # noqa: BLE001  CLI 要把失败原因原样告诉用户
        # pre_backup 必须回传：--force 已经把库清了，这个文件是用户唯一的退路
        emit(
            {
                "ok": False,
                "error": str(error),
                "pre_backup": state["pre_backup"],
                "stage": state["stage"],
            }
        )


if __name__ == "__main__":
    main()
