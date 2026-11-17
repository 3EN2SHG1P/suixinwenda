"""摘要刷新的失败分类：「数据库锁」要重试，「CAS 抢占」与其它错误不重试。

这两类混在一起时，SQLite 下的锁冲突会表现成「摘要永远不刷新，日志只有一行被忽略」。
"""
from sqlalchemy.exc import OperationalError

from core import summary


def _db_error(message: str) -> OperationalError:
    return OperationalError("UPDATE chat_summaries", {}, Exception(message))


def test_retries_on_database_locked_then_gives_up(monkeypatch, caplog):
    calls = []
    waits = []

    def boom(*args, **kwargs):
        calls.append(1)
        raise _db_error("database is locked")

    monkeypatch.setattr(summary, "_refresh", boom)
    monkeypatch.setattr(summary.time, "sleep", lambda seconds: waits.append(seconds))

    summary.refresh(1, object(), upto_message_id=5, cover_rounds_after=1)

    assert len(calls) == len(summary._LOCK_RETRY_WAITS) + 1, "锁冲突要按 3 次间隔重试"
    assert waits == list(summary._LOCK_RETRY_WAITS)
    assert "本次放弃" in caplog.text


def test_other_operational_error_is_not_retried(monkeypatch):
    calls = []

    def boom(*args, **kwargs):
        calls.append(1)
        raise _db_error("no such table: chat_summaries")

    monkeypatch.setattr(summary, "_refresh", boom)
    summary.refresh(1, object(), upto_message_id=5, cover_rounds_after=1)
    assert len(calls) == 1, "不是锁问题就立刻放弃，别空转 3 次"


def test_success_stops_immediately(monkeypatch):
    calls = []
    monkeypatch.setattr(summary, "_refresh", lambda *args, **kwargs: calls.append(1))
    summary.refresh(1, object(), upto_message_id=5, cover_rounds_after=1)
    assert len(calls) == 1
