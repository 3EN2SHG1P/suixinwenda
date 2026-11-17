"""摘要并发：多个线程同时刷新同一会话，不许抛异常、进度不许回退。

SQLite 的写锁会让并发的 CAS 互相撞：这里的意义是验证「撞了只放弃/重试，不会写坏」。
"""
import threading

import pytest
from sqlalchemy import text
from sqlmodel import Session

from core import context, summary
from core.database import engine
from models import ChatMessage, ChatSummary, Conversation

_created: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    if _created:
        with engine.begin() as conn:
            for cid in list(_created):
                conn.execute(
                    text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid}
                )
                conn.execute(
                    text("DELETE FROM chat_messages WHERE conversation_id = :c"), {"c": cid}
                )
                conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        _created.clear()


def _conversation() -> int:
    with Session(engine) as session:
        conv = Conversation(title="并发摘要", add_time=0, update_time=0)
        session.add(conv)
        session.commit()
        session.refresh(conv)
        _created.add(int(conv.id))
        return int(conv.id)


def _add(conversation_id: int, role: str, content: str) -> int:
    with Session(engine) as session:
        message = ChatMessage(conversation_id=conversation_id, role=role, content=content)
        session.add(message)
        session.commit()
        session.refresh(message)
        return int(message.id)


def test_concurrent_refresh_is_safe(fake_model):
    cid = _conversation()
    ids = [_add(cid, "user" if index % 2 == 0 else "assistant", f"第 {index} 条") for index in range(20)]
    upto = ids[-1]
    rounds = context.round_cursor(cid)[0]

    errors: list[Exception] = []

    def worker() -> None:
        try:
            summary.refresh(cid, fake_model, upto_message_id=upto, cover_rounds_after=rounds)
        except Exception as error:  # noqa: BLE001  这里就是要抓住任何漏网的异常
            errors.append(error)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == [], f"refresh 不该向外抛异常：{errors}"

    with Session(engine) as session:
        row = session.get(ChatSummary, cid)
    assert row is not None, "并发刷新后必须留下一条摘要"
    assert int(row.covered_message_id) <= int(upto), "覆盖上界不许超过实际算到的位置"
    assert int(row.covered_rounds) <= rounds, "轮数不许超过调用方给的基准"
    assert int(row.covered_rounds) >= 0
