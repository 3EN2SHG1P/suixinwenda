"""MySQL 方言契约：只在显式开启时跑（`TEST_MYSQL=1`），默认整套测试完全不碰外部服务。

为什么用环境变量而不是 pytest marker：marker 只解决「选中」，真正拦住它的是
conftest 里强制 `DB_BACKEND=sqlite`；只有显式开关才能同时表达「我确实要连 MySQL」，
也避免出现一条标了但没人知道怎么跑、永远 skip 的假入口。

跑法（本机或 CI）：
    TEST_MYSQL=1 uv run pytest tests/test_dialect_contract_mysql.py
需要 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD 可用（CI 的 mysql service 与本机都满足）。
"""
import os
from urllib.parse import quote_plus

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import DataError, IntegrityError
from sqlmodel import Session, SQLModel

pytestmark = pytest.mark.skipif(
    os.environ.get("TEST_MYSQL") != "1",
    reason="未设置 TEST_MYSQL=1：MySQL 契约测试默认不跑（本地与 CI 都按需开启）",
)

PROBE_DB = "suixinwenda_dialect_probe"


def _url(database: str = "") -> str:
    user = quote_plus(os.environ.get("DB_USER", "root"))
    password = quote_plus(os.environ.get("DB_PASSWORD", ""))
    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = os.environ.get("DB_PORT", "3306")
    return f"mysql+pymysql://{user}:{password}@{host}:{port}/{database}?charset=utf8mb4"


@pytest.fixture(scope="module")
def mysql_engine():
    """独占一个临时库：契约测试不碰用户真实库，跑完整库删掉。"""
    admin = create_engine(_url(), pool_pre_ping=True)
    with admin.begin() as conn:
        conn.execute(
            text(
                f"CREATE DATABASE IF NOT EXISTS {PROBE_DB} "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        )
    engine = create_engine(_url(PROBE_DB), pool_pre_ping=True)
    SQLModel.metadata.create_all(engine)
    yield engine
    engine.dispose()
    with admin.begin() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {PROBE_DB}"))
    admin.dispose()


def test_clip_prevents_data_too_long(mysql_engine):
    """SQLite 忽略 VARCHAR(n)、MySQL 报 1406：clip 之后必须能写，不 clip 必须炸。"""
    from core.limits import clip
    from models import Conversation

    with Session(mysql_engine) as session:
        session.add(Conversation(title=clip("长" * 500, 100), add_time=0, update_time=0))
        session.commit()

    with Session(mysql_engine) as session:
        session.add(Conversation(title="长" * 500, add_time=0, update_time=0))
        with pytest.raises(DataError):
            session.commit()


def test_username_unique_is_case_insensitive(mysql_engine):
    """MySQL 的 _ci 排序规则下 A@b.com 与 a@b.com 撞唯一索引——归一化不是可选项。"""
    from models import User

    with Session(mysql_engine) as session:
        session.add(User(username="A@b.com", password="x" * 20, nickname="A"))
        session.commit()

    with Session(mysql_engine) as session:
        session.add(User(username="a@b.com", password="x" * 20, nickname="a"))
        with pytest.raises(IntegrityError):
            session.commit()


def test_cas_rowcount_semantics(mysql_engine):
    """CAS 的 rowcount 必须是 1（抢到）与 0（被抢先），摘要刷新全靠它判断。"""
    from models import ChatSummary

    with Session(mysql_engine) as session:
        session.add(ChatSummary(conversation_id=901, summary="旧", covered_message_id=0))
        session.commit()

    statement = text(
        "UPDATE chat_summaries SET summary = :s, covered_message_id = :new "
        "WHERE conversation_id = 901 AND covered_message_id = :old"
    )
    with mysql_engine.begin() as conn:
        first = conn.execute(statement, {"s": "新", "new": 10, "old": 0})
        assert first.rowcount == 1
        second = conn.execute(statement, {"s": "更新", "new": 20, "old": 0})
        assert second.rowcount == 0, "旧基准已失效时必须抢不到"


def test_indexes_exist(mysql_engine):
    """两条关键索引在 MySQL 上也要有（模型里定义了 Index，不靠启动补）。"""
    inspector = inspect(mysql_engine)
    assert "ix_chat_messages_superseded" in {
        item["name"] for item in inspector.get_indexes("chat_messages")
    }
    assert "ix_conversations_user_update" in {
        item["name"] for item in inspector.get_indexes("conversations")
    }


def test_long_text_roundtrip(mysql_engine):
    """长正文写进 TEXT 再读回：20000 个中文字 ≈ 60KB，正好在 MySQL TEXT 的 64KB 内。"""
    from models import ChatMessage

    payload = "长" * 20000
    with Session(mysql_engine) as session:
        message = ChatMessage(conversation_id=901, role="user", content=payload)
        session.add(message)
        session.commit()
        session.refresh(message)
        assert len(message.content) == len(payload)


def test_text_column_has_64kb_ceiling_on_mysql(mysql_engine):
    """MySQL 的 TEXT 只有 64KB（字节），SQLite 的 TEXT 没有上限。

    这是「SQLite 能存、MySQL 存不进」的真实边界：单条回复超过 ~21k 汉字时，
    换到 MySQL 会直接报 1406。写在这里是为了让这条差异有据可查，而不是等用户撞上。
    """
    from models import ChatMessage

    payload = "长" * 30000  # 90000 字节 > 65535
    with Session(mysql_engine) as session:
        session.add(ChatMessage(conversation_id=902, role="user", content=payload))
        with pytest.raises(DataError):
            session.commit()
