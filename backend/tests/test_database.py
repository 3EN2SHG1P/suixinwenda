"""建表与结构测试：create_tables 必须幂等——每次启动都会跑，一旦不幂等就是「第二次开机起不来」。

断言一律走 SQLAlchemy 的 inspect，不查 information_schema：
后者是 MySQL 专属表，SQLite 上根本没有，测试会随后端切换而失效。
"""
from sqlalchemy import inspect, text

from core.database import create_tables, database_url, engine

BUSINESS_TABLES = {"conversations", "chat_messages", "chat_attachments", "chat_summaries", "users"}


def test_create_tables_is_idempotent():
    """连续调用两次不抛错（启动路径每次都跑一遍）。"""
    create_tables()
    create_tables()


def test_business_tables_all_created():
    """启动建表后 5 张业务表齐全。

    原先叫「..._without_checkpoint_tables」，但断言只查了业务表存在、从没查 checkpoint 三表「不存在」——
    老库里的残留表会让「不存在」断言永久失败，所以名字改成断言真正覆盖的事实（不测名字里没测的东西）。
    """
    names = set(inspect(engine).get_table_names())
    assert BUSINESS_TABLES <= names


def test_indexes_exist_across_dialects():
    """两条关键索引必须真的建出来。

    chat_messages.superseded 的索引原先只靠 MySQL 的 _ensure_indexes 补，
    模型里没有定义：新建的 SQLite 库就会缺，启动时的历史修复每次都全表扫聊天记录。
    """
    inspector = inspect(engine)
    message_indexes = {item["name"] for item in inspector.get_indexes("chat_messages")}
    conversation_indexes = {item["name"] for item in inspector.get_indexes("conversations")}
    assert "ix_chat_messages_superseded" in message_indexes
    assert "ix_conversations_user_update" in conversation_indexes


def test_added_columns_exist_across_dialects():
    """老库升级靠三列补齐，缺列会在查询时才炸（而不是启动时）。"""
    columns = {item["name"] for item in inspect(engine).get_columns("chat_messages")}
    assert {"superseded", "model", "question"} <= columns


def test_engine_can_execute_select():
    """engine 真能查（建表成功不代表连接可用）。"""
    with engine.connect() as conn:
        assert conn.execute(text("SELECT 1")).scalar() == 1


def test_database_url_percent_encodes_credentials(monkeypatch):
    """口令里的空格 / # / = / @ 必须按 percent-encoding 落进 URL。

    特别是空格：用 quote_plus 会编成 `+`，而 SQLAlchemy 按 unquote 解析（不解 `+`），
    实际拿去登录的就是「带加号的错口令」，表现为「密码明明对却认证失败」。
    """
    monkeypatch.setenv("DB_BACKEND", "mysql")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_USER", "us er")
    monkeypatch.setenv("DB_PASSWORD", "p@ss #1=")
    monkeypatch.setenv("DB_NAME", "db name")

    url = database_url()
    credentials = url.split("://", 1)[1].split("@", 1)[0]

    assert "us%20er" in credentials
    assert "p%40ss%20%231%3D" in credentials
    assert "+" not in credentials, "空格不能编成 +（SQLAlchemy 不会把它还原成空格）"
    assert "db%20name" in url
