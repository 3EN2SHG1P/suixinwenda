"""摘要区间的边界：上界那一问不能被永久丢掉。

为什么值得单独一条：covered_message_id 语义是「小于它的都已覆盖」，而它本身是
「下一轮的第一问」。旧的区间写法 `id > covered_id` 会把这一问排除在摘要之外，
但它的回答（id 更大）却会进下一批摘要——摘要里出现有答无问的孤立结论。
"""
import pytest
from sqlalchemy import text
from sqlmodel import Session

from core import summary
from core.database import engine
from models import ChatMessage, ChatSummary, Conversation

_created: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    if not _created:
        return
    with engine.begin() as conn:
        for cid in list(_created):
            conn.execute(text("DELETE FROM chat_messages WHERE conversation_id = :c"), {"c": cid})
            conn.execute(text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid})
            conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
    _created.clear()


def _conversation() -> int:
    with Session(engine) as session:
        conv = Conversation(title="摘要边界", add_time=0, update_time=0)
        session.add(conv)
        session.commit()
        session.refresh(conv)
        cid = int(conv.id)
    _created.add(cid)
    return cid


def _add(cid: int, role: str, content: str) -> int:
    with Session(engine) as session:
        row = ChatMessage(conversation_id=cid, role=role, content=content, add_time=0)
        session.add(row)
        session.commit()
        session.refresh(row)
        return int(row.id)


def _set_progress(cid: int, covered_message_id: int, covered_rounds: int) -> None:
    with Session(engine) as session:
        row = ChatSummary(
            conversation_id=cid,
            summary="已有摘要",
            covered_message_id=covered_message_id,
            covered_rounds=covered_rounds,
            add_time=0,
        )
        session.add(row)
        session.commit()


class _Recorder:
    def __init__(self):
        self.prompts: list[str] = []

    def invoke(self, messages):
        self.prompts.append(str(messages[-1].content))

        class _Reply:
            content = "压缩后的摘要"

        return _Reply()


def test_boundary_question_is_included_once():
    cid = _conversation()
    _add(cid, "user", "问一")
    _add(cid, "assistant", "答一")
    boundary = _add(cid, "user", "问二")   # 上一批的上界：当时没被摘要
    _add(cid, "assistant", "答二")
    upto = _add(cid, "user", "问三")       # 本次的新上界（不含）
    _set_progress(cid, boundary, covered_rounds=1)

    model = _Recorder()
    summary.refresh(cid, model, upto_message_id=upto, cover_rounds_after=2)

    assert len(model.prompts) == 1
    prompt = model.prompts[0]
    assert "问二" in prompt, "上界那一问必须补进摘要，否则它永远进不了上下文"
    assert "答二" in prompt
    assert "答一" not in prompt, "已覆盖的轮次不该重复进摘要"
    assert "问三" not in prompt, "新上界本身不在本次覆盖区间内"
