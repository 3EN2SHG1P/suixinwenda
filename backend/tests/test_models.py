"""表模型注册测试：只验 metadata，不连数据库。"""
from sqlmodel import SQLModel

import models  # noqa: F401


def test_three_tables_registered():
    """三张业务表都注册进 SQLModel.metadata。"""
    assert {"users", "conversations", "chat_messages"} <= set(SQLModel.metadata.tables)


def test_username_unique_and_indexes():
    """username 唯一；user_id / conversation_id 有索引。"""
    tables = SQLModel.metadata.tables
    assert any(c.unique for c in tables["users"].columns["username"].constraints) or \
        tables["users"].columns["username"].unique
    assert tables["conversations"].columns["user_id"].index
    assert tables["chat_messages"].columns["conversation_id"].index
