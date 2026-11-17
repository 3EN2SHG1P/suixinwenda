"""摘要刷新：节流式子、开区间上界、CAS 并发放弃、两列同步前进。"""
import logging
import threading

import pytest
from langchain_core.messages import AIMessage
from sqlalchemy import text
from sqlmodel import Session, select

from core import chat, context, summary
from core.database import engine
from models import ChatMessage, ChatSummary, Conversation

_created: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    """每个用例结束后清理本文件创建的会话、消息与摘要。"""
    yield
    if _created:
        with engine.begin() as conn:
            for cid in list(_created):
                conn.execute(
                    text("DELETE FROM chat_attachments WHERE conversation_id = :c"), {"c": cid}
                )
                conn.execute(
                    text("DELETE FROM chat_messages WHERE conversation_id = :c"), {"c": cid}
                )
                conn.execute(
                    text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid}
                )
                conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        _created.clear()


class _StubModel:
    """替身模型：只实现 invoke，记录调用次数并返回固定摘要。"""

    def __init__(self, reply: str = "摘要正文"):
        self.reply = reply
        self.calls = 0

    def invoke(self, messages):
        self.calls += 1
        return AIMessage(content=self.reply)


def _conversation() -> int:
    with Session(engine) as session:
        conv = Conversation(title="摘要测试", add_time=0, update_time=0)
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


def _rounds(cid: int, count: int) -> list[int]:
    """插 count 轮完整问答，返回每轮 user 消息 id。"""
    ids: list[int] = []
    for index in range(count):
        ids.append(_add(cid, "user", f"问{index}"))
        _add(cid, "assistant", f"答{index}")
    return ids


def _set_summary(cid: int, *, covered_message_id: int, covered_rounds: int, text_value: str = "已有摘要"):
    """直接落一行摘要（模拟上一批已经覆盖到的进度）。"""
    with Session(engine) as session:
        row = session.get(ChatSummary, cid)
        if row is None:
            row = ChatSummary(conversation_id=cid)
            session.add(row)
        row.summary = text_value
        row.covered_message_id = covered_message_id
        row.covered_rounds = covered_rounds
        row.add_time = 0
        session.commit()


def _row(cid: int):
    with Session(engine) as session:
        return session.get(ChatSummary, cid)


def _last_message_id(cid: int) -> int:
    with Session(engine) as session:
        return int(
            session.exec(
                select(ChatMessage.id)
                .where(ChatMessage.conversation_id == cid)
                .order_by(ChatMessage.id.desc())
                .limit(1)
            ).first()
        )


def _rounds_before(cid: int, message_id: int) -> int:
    """id 严格小于 message_id 的完整轮数（用来核对 covered_rounds 与 id 是否同一基准）。"""
    with Session(engine) as session:
        rows = session.exec(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == cid, ChatMessage.id < message_id)
            .order_by(ChatMessage.id.asc())
        ).all()
    rounds, _pending = context._pair_rounds(rows)
    return len(rounds)


def test_summary_schedule_enqueues_once_per_conversation(monkeypatch):
    """入队口径：停止/无模型不入队；同一会话在跑完前只入队一次。"""
    enqueued: list[int] = []
    # 不起真线程、不真入队：只观察「要不要排」
    monkeypatch.setattr(chat, "_ensure_worker", lambda: None)
    monkeypatch.setattr(
        chat,
        "_queue",
        type(
            "Q",
            (),
            {
                "put_nowait": staticmethod(enqueued.append),
                # 兼容只实现了 put 的旧替身：入队路径已改用 put_nowait（不阻塞聊天收尾）
                "put": staticmethod(enqueued.append),
            },
        )(),
    )
    monkeypatch.setattr(chat, "_pending", set())

    cid = _conversation()
    _rounds(cid, 16)  # pending = 16 - 10 - 0 = 6 >= 5

    chat._schedule_summary(cid, _StubModel(), None)
    assert enqueued == [cid], "未停止时应入队一次"

    chat._schedule_summary(cid, _StubModel(), None)
    assert enqueued == [cid], "同一会话还在排队/执行时不许重复入队"

    stopped = threading.Event()
    stopped.set()
    other = _conversation()
    chat._schedule_summary(other, _StubModel(), stopped)
    assert enqueued == [cid], "用户停止后不许排摘要"

    chat._schedule_summary(cid, None, None)
    assert enqueued == [cid], "模型不可用的回合不入队（那条路径 model 恒为 None）"

    enqueued.clear()
    chat._pending.discard(cid)  # 模拟 worker 已跑完
    chat._schedule_summary(cid, _StubModel(), None)
    assert enqueued == [cid], "跑完后才允许再次入队"


def test_summary_queue_full_drops_instead_of_blocking(monkeypatch):
    """队列满时丢任务并清去重标记：不能阻塞聊天收尾，也不能让该会话永久不再刷新。"""
    import queue as queue_module

    class _Full:
        def put_nowait(self, item):
            raise queue_module.Full

    monkeypatch.setattr(chat, "_ensure_worker", lambda: None)
    monkeypatch.setattr(chat, "_queue", _Full())
    monkeypatch.setattr(chat, "_pending", set())

    cid = _conversation()
    _rounds(cid, 16)
    chat._schedule_summary(cid, _StubModel(), None)  # 不许抛
    assert cid not in chat._pending, "丢弃后必须清标记，否则该会话永远不再刷新"


def test_summary_task_survives_model_error(monkeypatch):
    """worker 侧兜底：任务抛错只记日志，pending 被清掉，后续任务照常执行。"""
    calls: list[int] = []

    def _boom(cid, model):
        calls.append(cid)
        raise RuntimeError("模拟摘要线程内的意外异常")

    monkeypatch.setattr(summary, "refresh_latest", _boom)
    monkeypatch.setattr(chat.ai, "get_model", lambda *args, **kwargs: _StubModel())
    monkeypatch.setattr(chat, "_pending", {7})

    chat._run_summary_task(7)  # 不许抛出去，否则唯一的摘要线程会直接死掉
    assert calls == [7]
    assert 7 not in chat._pending, "失败也要把去重标记清掉，否则该会话永久不再刷新"

    monkeypatch.setattr(summary, "refresh_latest", lambda cid, model: calls.append(cid))
    chat._run_summary_task(8)
    assert calls == [7, 8], "一次失败不能影响后续任务"


def test_summary_refresh_throttled():
    """pending < 5 不触发、>= 5 触发一次；含连续多轮不触发的断言。"""
    # 覆盖 0 轮：pending = rounds - 10，15 轮起（积压 5 轮）触发，14 轮及以下不触发
    assert [context.should_summarize(n, 0) for n in (13, 14, 15, 16)] == [False, False, True, True]
    # 已覆盖到 6 轮：17~20 轮（pending=1..4）连续不触发，21 轮（pending=5）再触发
    assert [context.should_summarize(n, 6) for n in (16, 17, 18, 19, 20)] == [
        False,
        False,
        False,
        False,
        False,
    ]
    assert context.should_summarize(21, 6) is True

    # 同一批数据走真实取值：plan_refresh 与上面的式子一致
    cid = _conversation()
    ids = _rounds(cid, 16)
    _set_summary(cid, covered_message_id=ids[6], covered_rounds=6)
    should, upto, cover_rounds_after = context.plan_refresh(cid)
    assert should is False, "已覆盖 6 轮时 16 轮没有新积压"
    assert upto == ids[6]
    assert cover_rounds_after == 6

    extra = _conversation()
    extra_ids = _rounds(extra, 21)
    _set_summary(extra, covered_message_id=extra_ids[6], covered_rounds=6)
    should, upto, cover_rounds_after = context.plan_refresh(extra)
    assert should is True, "积压到 5 轮才触发"
    assert upto == extra_ids[11]
    assert cover_rounds_after == 11


def test_summary_upto_open_interval():
    """upto <= covered_message_id 或区间为空时 refresh 不写入（也不调模型）。"""
    cid = _conversation()
    _rounds(cid, 2)
    last_id = _last_message_id(cid)  # 第二轮回答的 id
    _set_summary(cid, covered_message_id=last_id, covered_rounds=2)

    model = _StubModel()
    summary.refresh(cid, model, upto_message_id=last_id, cover_rounds_after=5)
    assert model.calls == 0, "上界没前进就不该生成摘要"
    assert _row(cid).covered_message_id == last_id

    # 上界前进了 1，但区间内一条消息都没有：同样不写（否则那段永远进不了摘要）
    summary.refresh(cid, model, upto_message_id=last_id + 1, cover_rounds_after=5)
    assert model.calls == 0
    assert _row(cid).covered_message_id == last_id

    # 有真实区间才写
    cid2 = _conversation()
    ids2 = _rounds(cid2, 2)
    model2 = _StubModel()
    summary.refresh(cid2, model2, upto_message_id=ids2[-1], cover_rounds_after=1)
    assert model2.calls == 1
    assert _row(cid2).covered_message_id == ids2[-1]


def test_summary_cas_conflict_abandons(monkeypatch, caplog):
    """写前被别人改动：不覆盖、不抛异常、只记日志。"""
    cid = _conversation()
    ids = _rounds(cid, 2)
    _set_summary(cid, covered_message_id=ids[0], covered_rounds=0)
    upto = ids[1]

    def _condense_with_conflict(model, old_summary, lines):
        """模拟另一个任务在我们生成摘要期间先写成功。"""
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE chat_summaries SET summary = '别人写的', covered_message_id = :u, "
                    "covered_rounds = 1 WHERE conversation_id = :c"
                ),
                {"u": upto, "c": cid},
            )
        return "我的摘要"

    monkeypatch.setattr(summary, "_condense", _condense_with_conflict)

    with caplog.at_level(logging.INFO):
        summary.refresh(cid, _StubModel(), upto_message_id=upto, cover_rounds_after=1)

    row = _row(cid)
    assert row.summary == "别人写的", "CAS 失败时绝不能覆盖别人写的结果"
    assert row.covered_message_id == upto
    assert row.covered_rounds == 1
    assert "CAS 失败" in caplog.text


def test_delete_conversation_removes_summary():
    """删除会话：chat_summaries 在同一事务里清掉，不留残行。"""
    from core import history

    cid = _conversation()
    _rounds(cid, 1)
    _set_summary(cid, covered_message_id=_last_message_id(cid), covered_rounds=1)

    history.delete_conversation(cid, None)

    with engine.connect() as conn:
        remain = conn.execute(
            text("SELECT COUNT(*) FROM chat_summaries WHERE conversation_id = :c"), {"c": cid}
        ).scalar()
        messages = conn.execute(
            text("SELECT COUNT(*) FROM chat_messages WHERE conversation_id = :c"), {"c": cid}
        ).scalar()
    assert remain == 0
    assert messages == 0


class _RecordingModel:
    """替身模型：记录每次进 prompt 的正文，用来断言「输入被截断了多少」。"""

    def __init__(self, reply: str = "摘要正文"):
        self.reply = reply
        self.prompts: list[str] = []

    def invoke(self, messages):
        self.prompts.append(str(messages[-1].content))
        return AIMessage(content=self.reply)


def test_condense_prompt_truncates_keeps_old_summary_and_newest(monkeypatch):
    """超长输入：旧摘要优先、新增对话从最新往回取、总长不超过上限。"""
    monkeypatch.setattr(summary, "SUMMARY_INPUT_MAX_CHARS", 500)
    old_summary = "旧" * 100
    lines = [f"第{index}条：" + "长" * 100 for index in range(50)]

    prompt = summary._condense_prompt(old_summary, lines)

    assert prompt.startswith("（已有摘要）"), "旧摘要必须排在最前且被保留"
    assert old_summary in prompt
    assert len(prompt) <= 500, f"输入没有被截断：{len(prompt)}"
    assert lines[-1] in prompt, "最新一条必须留在 prompt 里"
    assert lines[0] not in prompt, "最旧的几条应该先被丢掉"


def test_summary_refresh_with_oversized_history_still_generates(monkeypatch):
    """积压轮次的内容远超输入上限时，摘要仍能生成并落库（不是「一直不刷新」）。"""
    monkeypatch.setattr(summary, "SUMMARY_INPUT_MAX_CHARS", 400)
    cid = _conversation()
    ids = []
    for index in range(3):
        ids.append(_add(cid, "user", f"第{index}轮提问：" + "早" * 300))
        _add(cid, "assistant", f"第{index}轮回答：" + "答" * 300)
    # 覆盖区间是开区间（id < upto）：最后追加一条当上界，真正的「最新」是上一轮的助手回答
    ids.append(_add(cid, "user", "边界消息：不进摘要"))

    model = _RecordingModel("压缩后的摘要")
    summary.refresh(cid, model, upto_message_id=ids[-1], cover_rounds_after=3)

    assert len(model.prompts) == 1, "超长输入不该让摘要任务被跳过"
    assert len(model.prompts[0]) <= 400
    assert "第2轮回答" in model.prompts[0], "最新一轮必须进入 prompt（从最新往回取）"
    assert "第0轮提问" not in model.prompts[0], "更早的轮次应该先被截掉"
    row = _row(cid)
    assert row is not None and row.summary == "压缩后的摘要"
    assert row.covered_message_id == ids[-1]


def test_summary_rounds_and_message_id_move_together():
    """写入后 covered_rounds 与 covered_message_id 严格对应，且都在同一条 SQL 前进。"""
    cid = _conversation()
    ids = _rounds(cid, 3)
    upto = ids[2]  # 第三轮 user：覆盖前两轮

    summary.refresh(cid, _StubModel("压缩后的摘要"), upto_message_id=upto, cover_rounds_after=2)

    row = _row(cid)
    assert row is not None
    assert row.summary == "压缩后的摘要"
    assert row.covered_message_id == upto
    assert row.covered_rounds == 2
    # 同一基准核对：id 小于上界的完整轮数正好等于 covered_rounds
    assert _rounds_before(cid, row.covered_message_id) == row.covered_rounds
