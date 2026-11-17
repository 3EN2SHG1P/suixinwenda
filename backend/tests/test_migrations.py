"""结构对齐测试：新库要对齐到模型，旧库（缺列缺索引）要在一次 upgrade 后收敛。

这两条守的是「模型加了列、升级逻辑忘了补」——它不会报错，只会在用户查询时炸。
"""
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlmodel import SQLModel

from core import migrations


@pytest.fixture
def isolated_engine(monkeypatch, tmp_path):
    """换成一个独立临时库：不动全局 engine（否则测试之间会互删表）。"""
    probe = create_engine(f"sqlite:///{(tmp_path / 'probe.db').as_posix()}")
    monkeypatch.setattr(migrations, "engine", probe)
    yield probe
    probe.dispose()


@pytest.fixture
def no_backup(monkeypatch):
    """对齐前会自动备份：测试里换成空实现，避免往真实 DATA_DIR 写 zip。"""
    calls = []
    monkeypatch.setattr(
        migrations.backup, "create_timestamped_backup", lambda: calls.append(1) or Path("fake.zip")
    )
    return calls


def _snapshot(engine) -> dict:
    inspector = inspect(engine)
    return {
        table: {
            "columns": {item["name"] for item in inspector.get_columns(table)},
            "indexes": {item["name"] for item in inspector.get_indexes(table)},
        }
        for table in inspector.get_table_names()
    }


def test_fresh_db_matches_metadata(isolated_engine, no_backup):
    """全新库：upgrade 之后的结构必须与模型定义一模一样。"""
    result = migrations.upgrade()
    assert result["columns"] == 0 and result["indexes"] == 0, "新库不该触发补列补索引"
    assert no_backup == [], "没有变更就不该产生备份"

    actual = _snapshot(isolated_engine)
    expected = {
        table.name: {
            "columns": {column.name for column in table.columns},
            "indexes": {index.name for index in table.indexes if index.name},
        }
        for table in SQLModel.metadata.tables.values()
    }
    assert actual == expected, "新库结构与模型定义不一致"


def test_legacy_db_converges_after_upgrade(isolated_engine, no_backup):
    """旧库：缺 question 列、缺 superseded 索引，一次 upgrade 后必须补齐。"""
    SQLModel.metadata.create_all(isolated_engine)
    with isolated_engine.begin() as conn:
        conn.execute(text("DROP INDEX ix_chat_messages_superseded"))
        conn.execute(text("ALTER TABLE chat_messages DROP COLUMN question"))

    before = _snapshot(isolated_engine)
    assert "question" not in before["chat_messages"]["columns"]
    assert "ix_chat_messages_superseded" not in before["chat_messages"]["indexes"]

    result = migrations.upgrade()
    assert result["columns"] == 1
    assert result["indexes"] == 1
    assert no_backup == [1], "改结构之前必须先备份"

    after = _snapshot(isolated_engine)
    assert "question" in after["chat_messages"]["columns"]
    assert "ix_chat_messages_superseded" in after["chat_messages"]["indexes"]

    # 再跑一次必须是无操作（幂等）
    again = migrations.upgrade()
    assert again == {"columns": 0, "indexes": 0, "backup": ""}


def test_backup_failure_blocks_upgrade(isolated_engine, monkeypatch):
    """备份失败就不许改结构：宁可这次不升级，也不能在没有退路的库上执行 DDL。"""
    SQLModel.metadata.create_all(isolated_engine)
    with isolated_engine.begin() as conn:
        conn.execute(text("DROP INDEX ix_chat_messages_superseded"))

    def boom():
        raise RuntimeError("找不到 mysqldump")

    monkeypatch.setattr(migrations.backup, "create_timestamped_backup", boom)
    with pytest.raises(RuntimeError, match="mysqldump"):
        migrations.upgrade()

    after = _snapshot(isolated_engine)
    assert "ix_chat_messages_superseded" not in after["chat_messages"]["indexes"], "结构不该被改动"


def test_fingerprint_changes_when_schema_changes(isolated_engine, no_backup):
    """结构指纹：同结构稳定、结构变了就变——它是「库有没有被动过」的判断依据。"""
    SQLModel.metadata.create_all(isolated_engine)
    first = migrations.schema_fingerprint()
    assert migrations.schema_fingerprint() == first

    with isolated_engine.begin() as conn:
        conn.execute(text("DROP INDEX ix_chat_messages_superseded"))
    assert migrations.schema_fingerprint() != first
