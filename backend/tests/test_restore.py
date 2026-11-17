"""恢复测试：三种来源都要能写进独立临时库，且失败时不许污染全局测试库。

`tests/conftest.py` 是 session 级单库（engine 是模块级单例）。恢复会清空整库，
所以每个用例都必须把被测模块和 purge 模块的 engine 一起换成独立库，
并把 DATA_DIR / UPLOAD_DIR 指到 tmp_path——少换一个就会把全量测试的数据清掉。
"""
import json
import os
import sqlite3
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlmodel import Session, SQLModel, select

from models import ChatAttachment, ChatMessage, Conversation, User
from tools import purge, restore

# 老库的建表语句：chat_messages 故意不含 question / superseded / model，
# 用来验证「备份可能是老版本，必须按目标列取交集」
OLD_DDL = (
    "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, nickname TEXT,"
    " avatar TEXT, status INTEGER, add_time INTEGER)",
    "CREATE TABLE conversations (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT,"
    " add_time INTEGER, update_time INTEGER)",
    "CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, role TEXT,"
    " content TEXT, add_time INTEGER)",
    "CREATE TABLE chat_attachments (id INTEGER PRIMARY KEY, message_id INTEGER,"
    " conversation_id INTEGER, name TEXT, mime TEXT, size INTEGER, kind TEXT, sha256 TEXT,"
    " stored_path TEXT, text_excerpt TEXT, truncated INTEGER, add_time INTEGER)",
    "CREATE TABLE chat_summaries (conversation_id INTEGER PRIMARY KEY, summary TEXT,"
    " covered_message_id INTEGER, covered_rounds INTEGER, add_time INTEGER)",
)


@pytest.fixture
def sandbox(monkeypatch, tmp_path):
    """独立目标库 + 独立数据目录 + 假备份：恢复的写库动作绝不碰全局测试库。"""
    probe = create_engine(f"sqlite:///{(tmp_path / 'target.db').as_posix()}")
    SQLModel.metadata.create_all(probe)
    backups = []
    stub = tmp_path / "before-restore-stub.zip"
    monkeypatch.setattr(restore, "engine", probe)
    # --force 用例必须一起换：purge 用的是它自己模块里的 engine
    monkeypatch.setattr(purge, "engine", probe)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    # 不 stub 的话，create_timestamped_backup() 走 db_info.sqlite_path()（每次读 env，与 probe 无关），
    # 「没有多出备份文件」这类断言会数到 session 共享目录里别人的备份
    monkeypatch.setattr(
        restore,
        "create_timestamped_backup",
        lambda prefix="before-upgrade": backups.append(prefix) or stub,
    )
    yield SimpleNamespace(engine=probe, tmp=tmp_path, backups=backups, stub=stub)
    probe.dispose()


def _sqlite_db(path: Path, rows: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        for ddl in OLD_DDL:
            conn.execute(ddl)
        for table, items in rows.items():
            for item in items:
                columns = ", ".join(item)
                marks = ", ".join("?" for _ in item)
                conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})", tuple(item.values()))
        conn.commit()
    finally:
        conn.close()


def _zip(path: Path, members: dict) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, data in members.items():
            bundle.writestr(name, data)
    return path


def _sqlite_backup(tmp_path: Path, rows: dict, uploads: dict | None = None) -> Path:
    db_file = tmp_path / "src" / "suixinwenda.db"
    _sqlite_db(db_file, rows)
    members = {
        "manifest.json": json.dumps({"backend": "sqlite", "db": "db/suixinwenda.db"}),
        "db/suixinwenda.db": db_file.read_bytes(),
    }
    for rel, data in (uploads or {}).items():
        members[f"uploads/{rel}"] = data
    return _zip(tmp_path / "backup.zip", members)


def _export_dir(tmp_path: Path, rows: dict) -> Path:
    """按 tools/export.py 的口径造导出目录：逐行 JSONL + 逐行累积的 sha256。"""
    import hashlib

    out = tmp_path / "export"
    out.mkdir(parents=True, exist_ok=True)
    tables = {}
    for table, items in rows.items():
        hasher = hashlib.sha256()
        with (out / f"{table}.jsonl").open("w", encoding="utf-8", newline="\n") as handle:
            for item in items:
                line = json.dumps(item, ensure_ascii=False) + "\n"
                handle.write(line)
                hasher.update(line.encode("utf-8"))
        tables[table] = {"rows": len(items), "sha256": hasher.hexdigest()}
    (out / "manifest.json").write_text(
        json.dumps({"backend": "sqlite", "tables": tables}, ensure_ascii=False), encoding="utf-8"
    )
    return out


def _run(source: Path, uploads_from: Path | None = None, force: bool = False) -> dict:
    state = {"pre_backup": "", "stage": "inspect"}
    result = restore.run_restore(source, uploads_from, force, state)
    result["_state"] = state
    return result


def _rows(rows: dict) -> dict:
    return {
        "users": [
            {
                "id": 1,
                "username": "keep@test.local",
                "password": "old-hash",
                "nickname": "老王",
                "avatar": "",
                "status": 1,
                "add_time": 100,
            }
        ],
        "conversations": [
            {"id": 5, "user_id": 1, "title": "恢复的会话", "add_time": 10, "update_time": 20}
        ],
        "chat_messages": [
            {"id": 7, "conversation_id": 5, "role": "user", "content": "你好", "add_time": 11},
            {"id": 8, "conversation_id": 5, "role": "assistant", "content": "你好呀", "add_time": 12},
        ],
        "chat_attachments": [
            {
                "id": 3,
                "message_id": 7,
                "conversation_id": 5,
                "name": "a.png",
                "mime": "image/png",
                "size": 4,
                "kind": "image",
                "sha256": "a" * 64,
                "stored_path": "aa/" + "a" * 64 + ".png",
                "text_excerpt": "",
                "truncated": 0,
                "add_time": 11,
            }
        ],
        "chat_summaries": [
            {
                "conversation_id": 5,
                "summary": "摘要",
                "covered_message_id": 8,
                "covered_rounds": 1,
                "add_time": 13,
            }
        ],
    }


def test_sqlite_backup_restores_all_tables(sandbox):
    source = _sqlite_backup(sandbox.tmp, _rows({}), {"aa/" + "a" * 64 + ".png": b"data"})

    result = _run(source)

    assert result["source"] == "zip"
    assert result["tables"] == {
        "users": 1,
        "conversations": 1,
        "chat_messages": 2,
        "chat_attachments": 1,
        "chat_summaries": 1,
    }
    assert result["files"] == 1
    assert sandbox.backups == ["before-restore"], "恢复前必须先自动备份，且用 before-restore 前缀"
    with Session(sandbox.engine) as session:
        # 老备份缺 question / superseded / model：必须按目标列取交集，缺失列走默认值
        message = session.exec(select(ChatMessage).where(ChatMessage.id == 7)).one()
        assert message.content == "你好"
        assert message.model == ""
        assert message.superseded == 0
        assert message.question is None
    assert (Path(os.environ["UPLOAD_DIR"]) / "sqlite" / ("aa/" + "a" * 64 + ".png")).is_file()


def test_mysql_script_is_validated_and_executed_with_same_split(monkeypatch):
    """校验与执行必须共用一次切分：否则「同一行写两条语句」就能只让校验看到第一条。

    执行侧已不再启用 MULTI_STATEMENTS，多语句文本会在 execute 时报语法错（失败关闭），
    这里断言的是「执行侧收到的就是切分后的单条语句」。
    """
    executed: list[str] = []

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, statement):
            executed.append(statement)

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def close(self):
            pass

    monkeypatch.setitem(
        sys.modules,
        "pymysql",
        SimpleNamespace(connect=lambda **kwargs: FakeConnection()),
    )

    restore._execute_mysql_script("SET NAMES utf8mb4;\nINSERT INTO users VALUES (1);\n")

    assert len(executed) == 2, "必须逐条执行，不能整包丢给 MULTI_STATEMENTS"
    assert executed[0].startswith("SET NAMES")
    assert executed[1].startswith("INSERT INTO")


def test_validation_rejects_dangerous_statement_on_its_own_line():
    """白名单之外的语句（同一行多条 / 单独一行）都要在校验阶段就被拒绝。"""
    with pytest.raises(restore.RestoreError, match="不允许的语句"):
        restore._validate_sql_statements("SET NAMES utf8mb4;\nDROP DATABASE suixinwenda;\n")


def test_validation_allows_mysqldump_style_bundle():
    """正常 mysqldump 产物不能被误判（注释行 + 行尾分号）。"""
    restore._validate_sql_statements(
        "-- 导出\n"
        "/*!40101 SET NAMES utf8mb4 */;\n"
        "DROP TABLE IF EXISTS `users`;\n"
        "CREATE TABLE `users` (`id` int NOT NULL);\n"
        "INSERT INTO `users` VALUES (1);\n"
    )


def test_backup_with_unknown_db_member_is_rejected(sandbox):
    """备份包只认唯一成员名：其它名字一律当「不是随心问答的备份」，不做兼容猜测。"""
    db_file = sandbox.tmp / "src" / "other.db"
    _sqlite_db(db_file, _rows({}))
    source = _zip(
        sandbox.tmp / "other-backup.zip",
        {
            "manifest.json": json.dumps({"backend": "sqlite", "db": "db/other.db"}),
            "db/other.db": db_file.read_bytes(),
        },
    )

    with pytest.raises(restore.RestoreError, match="不是随心问答的备份"):
        restore.detect_source(source)


def test_export_dir_restores_and_checks_sha(sandbox):
    export = _export_dir(sandbox.tmp, _rows({}))

    result = _run(export)
    assert result["source"] == "export"
    assert result["tables"]["chat_messages"] == 2
    assert result["files"] == 0, "导出不含附件"
    # 导出目录不含附件：库里仍有引用，必须明确告诉用户「有 N 个附件没找到」，
    # 否则他会在历史里逐条点开才发现全是 404
    assert result["missing_attachments"] == 1
    assert "没找到" in result["warning"]

    # 改一行但不改 manifest：sha 对不上必须拒绝（否则恢复的是半截数据）
    bad = sandbox.tmp / "export-bad"
    bad.mkdir()
    for item in export.iterdir():
        (bad / item.name).write_bytes(item.read_bytes())
    (bad / "chat_messages.jsonl").write_text('{"id": 1, "content": "篡改"}\n', encoding="utf-8")
    with pytest.raises(restore.RestoreError, match="校验不一致"):
        restore.run_restore(bad, None, True, {"pre_backup": "", "stage": "inspect"})


def test_export_dir_with_uploads_from_zip(sandbox):
    export = _export_dir(sandbox.tmp, _rows({}))
    uploads = _sqlite_backup(sandbox.tmp, {}, {"bb/" + "b" * 64 + ".png": b"img"})

    result = _run(export, uploads_from=uploads)

    assert result["files"] == 1
    assert (Path(os.environ["UPLOAD_DIR"]) / "sqlite" / ("bb/" + "b" * 64 + ".png")).is_file()


def test_force_purges_then_restores(sandbox):
    with Session(sandbox.engine) as session:
        session.add(Conversation(id=99, title="旧会话", add_time=0, update_time=0))
        session.add(ChatMessage(conversation_id=99, role="user", content="旧消息"))
        session.commit()
    stale = Path(os.environ["UPLOAD_DIR"]) / "sqlite" / "cc" / "old.png"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"old")
    source = _sqlite_backup(sandbox.tmp, _rows({}))

    result = _run(source, force=True)

    with Session(sandbox.engine) as session:
        assert session.exec(select(Conversation).where(Conversation.id == 99)).first() is None
        assert len(session.exec(select(Conversation)).all()) == 1
    assert not stale.exists(), "--force 会先清空附件目录"
    assert result["tables"]["conversations"] == 1


def test_non_empty_target_is_rejected_without_backup(sandbox):
    with Session(sandbox.engine) as session:
        session.add(Conversation(title="已有", add_time=0, update_time=0))
        session.commit()
    source = _sqlite_backup(sandbox.tmp, _rows({}))

    with pytest.raises(restore.RestoreError, match="目标库已有会话数据"):
        _run(source)

    assert sandbox.backups == [], "拒绝时不许产生备份文件"
    assert not sandbox.stub.exists()
    with Session(sandbox.engine) as session:
        assert len(session.exec(select(Conversation)).all()) == 1, "已有数据必须原样保留"


def test_users_merge_keeps_target_password(sandbox):
    with Session(sandbox.engine) as session:
        session.add(
            User(id=7, username="keep@test.local", password="target-hash", nickname="新昵称", add_time=999)
        )
        session.commit()
    source = _sqlite_backup(sandbox.tmp, _rows({}))

    result = _run(source)

    assert result["users_merged"] == 1
    assert result["users_inserted"] == 0
    assert result["tables"]["users"] == 1
    with Session(sandbox.engine) as session:
        user = session.exec(select(User)).one()
        assert user.id == 7
        assert user.password == "target-hash", "已存在的账号不许被旧密码覆盖"
        assert user.nickname == "新昵称"
        conv = session.exec(select(Conversation)).one()
        assert conv.user_id == 7, "会话的 user_id 要改写成目标库的用户 id"


def test_users_id_conflict_aborts(sandbox):
    with Session(sandbox.engine) as session:
        session.add(User(id=1, username="other@test.local", password="x", add_time=0))
        session.commit()
    source = _sqlite_backup(sandbox.tmp, _rows({}))

    with pytest.raises(restore.RestoreError, match="已被「other@test.local」占用"):
        _run(source)

    with Session(sandbox.engine) as session:
        assert session.exec(select(Conversation)).first() is None, "中止时不许留下半截数据"


def test_attachment_reuse_when_same_size(sandbox):
    rel = "aa/" + "a" * 64 + ".png"
    target = Path(os.environ["UPLOAD_DIR"]) / "sqlite" / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"data")
    source = _sqlite_backup(sandbox.tmp, _rows({}), {rel: b"data"})

    result = _run(source)

    assert result["files"] == 1
    assert target.read_bytes() == b"data"


def test_attachment_size_mismatch_reports_file(sandbox):
    rel = "aa/" + "a" * 64 + ".png"
    target = Path(os.environ["UPLOAD_DIR"]) / "sqlite" / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"longer-content")
    source = _sqlite_backup(sandbox.tmp, _rows({}), {rel: b"data"})

    with pytest.raises(restore.RestoreError, match="内容不一致"):
        _run(source)

    assert target.read_bytes() == b"longer-content", "冲突时不许静默覆盖"


def test_attachment_same_size_different_content_rejected(sandbox):
    """只比大小会把「大小相同的另一份文件」当成同一份，恢复后图片/文档静默变错。"""
    rel = "aa/" + "a" * 64 + ".png"
    target = Path(os.environ["UPLOAD_DIR"]) / "sqlite" / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"aaaa")
    source = _sqlite_backup(sandbox.tmp, _rows({}), {rel: b"bbbb"})

    with pytest.raises(restore.RestoreError, match="内容不一致"):
        _run(source)

    assert target.read_bytes() == b"aaaa"


def test_mysql_backup_rejected_on_sqlite(sandbox):
    source = _zip(
        sandbox.tmp / "mysql.zip",
        {
            "manifest.json": json.dumps({"backend": "mysql"}),
            "db/suixinwenda.sql": "DROP TABLE IF EXISTS `users`;\nCREATE TABLE `users` (id int);\n",
        },
    )

    with pytest.raises(restore.RestoreError, match="这是 MySQL 备份，当前是 SQLite"):
        _run(source)

    assert sandbox.backups == [], "来源与当前后端不匹配时不许动库"


def test_sql_table_whitelist():
    ok = (
        "DROP TABLE IF EXISTS `users`;\n"
        "CREATE TABLE `users` (id int);\n"
        "INSERT INTO `users` VALUES (1);\n"
        "DROP TABLE IF EXISTS `checkpoints`;\n"
        "CREATE TABLE `checkpoints` (id int);\n"
    )
    assert restore.validate_sql_tables(ok) == ["checkpoints"]

    with pytest.raises(restore.RestoreError, match="不是随心问答的表：secret"):
        restore.validate_sql_tables("DROP TABLE IF EXISTS `secret`;\nCREATE TABLE `secret` (id int);\n")

    with pytest.raises(restore.RestoreError, match="SQL 里没有任何业务表"):
        restore.validate_sql_tables("SET sql_mode='NO_BACKSLASH_ESCAPES';\n")


def test_dangerous_sql_statements_rejected():
    """整包是用 MULTI_STATEMENTS 直接执行的：表名白名单挡不住 DROP DATABASE / 写文件。"""
    base = (
        "SET sql_mode='NO_BACKSLASH_ESCAPES';\n"
        "DROP TABLE IF EXISTS `users`;\n"
        "CREATE TABLE `users` (id int);\n"
        "INSERT INTO `users` VALUES (1);\n"
    )
    for bad in (
        "DROP DATABASE suixinwenda;\n",
        "SELECT * FROM users INTO OUTFILE '/tmp/x';\n",
        "GRANT ALL ON *.* TO 'x'@'%';\n",
        "UPDATE users SET password='x';\n",
        "CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW SET @a = 1;\n",
    ):
        with pytest.raises(restore.RestoreError, match="不允许的语句"):
            restore.validate_sql_tables(base + bad)


def test_zip_traversal_rejected(sandbox):
    source = _zip(
        sandbox.tmp / "evil.zip",
        {"db/suixinwenda.db": b"", "../evil.png": b"x"},
    )

    with pytest.raises(restore.RestoreError, match="非法路径"):
        _run(source)

    assert not (sandbox.tmp / "evil.png").exists()


def test_row_count_mismatch_rolls_back(sandbox):
    rows = _rows({})
    # chat_summaries 的主键是 conversation_id：同一会话两条摘要必然冲突
    # （用导出目录造数据：.db 快照自己就会拒绝重复主键，测不到写库那一步）
    rows["chat_summaries"] = rows["chat_summaries"] * 2
    source = _export_dir(sandbox.tmp, rows)

    with pytest.raises(restore.RestoreError, match="已回滚"):
        _run(source)

    with Session(sandbox.engine) as session:
        assert session.exec(select(Conversation)).first() is None, "写库失败必须整体回滚"
        assert session.exec(select(ChatAttachment)).first() is None


def test_missing_table_is_created(sandbox, monkeypatch):
    """目标库缺表时才建：无条件 create_tables() 会让「只读检查」变成假话。"""
    with sandbox.engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE chat_summaries")
    created = []
    monkeypatch.setattr(
        restore,
        "create_tables",
        lambda: created.append(1) or SQLModel.metadata.create_all(sandbox.engine),
    )

    result = _run(_sqlite_backup(sandbox.tmp, _rows({})))

    assert created == [1]
    assert result["tables"]["chat_summaries"] == 1


@pytest.mark.skipif(
    os.environ.get("TEST_MYSQL") != "1",
    reason="未设置 TEST_MYSQL=1：不连外部 MySQL（本机与 CI 都按需开启）",
)
def test_sqlite_backup_into_mysql(sandbox, monkeypatch, tmp_path):
    """SQLite 备份 → MySQL 目标库：列过滤与显式 id 插入在另一边同样要成立。"""
    from urllib.parse import quote_plus

    from sqlalchemy import text

    admin = create_engine(
        "mysql+pymysql://"
        f"{quote_plus(os.environ.get('DB_USER', 'root'))}:{quote_plus(os.environ.get('DB_PASSWORD', ''))}"
        f"@{os.environ.get('DB_HOST', '127.0.0.1')}:{os.environ.get('DB_PORT', '3306')}/?charset=utf8mb4",
        pool_pre_ping=True,
    )
    probe_db = "suixinwenda_restore_probe"
    with admin.begin() as conn:
        conn.execute(
            text(f"CREATE DATABASE IF NOT EXISTS {probe_db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        )
    target = create_engine(
        "mysql+pymysql://"
        f"{quote_plus(os.environ.get('DB_USER', 'root'))}:{quote_plus(os.environ.get('DB_PASSWORD', ''))}"
        f"@{os.environ.get('DB_HOST', '127.0.0.1')}:{os.environ.get('DB_PORT', '3306')}/{probe_db}"
        "?charset=utf8mb4",
        pool_pre_ping=True,
    )
    SQLModel.metadata.create_all(target)
    monkeypatch.setattr(restore, "engine", target)
    try:
        result = _run(_sqlite_backup(sandbox.tmp, _rows({})))
        assert result["tables"]["chat_messages"] == 2
        with target.begin() as conn:
            assert conn.execute(text("SELECT COUNT(*) FROM conversations")).scalar() == 1
    finally:
        target.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {probe_db}"))
        admin.dispose()
