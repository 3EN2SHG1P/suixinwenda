"""流式攒帧与「重新生成」的边界行为。

为什么单独成文件：这两条都是「看起来没坏、实际在悄悄丢东西」的路径——
逐字发帧会让前端每字重排一次；模型不可用时点重新生成会往历史里多插一条提问。
"""
import json
import re
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import select

import core.ai as ai
from core import chat
from core.database import engine
from main import app

client = TestClient(app)

# 本文件创建的会话 id：测试结束统一清理，避免污染后续用例
_created: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    """用例失败也要清库：否则残留会话会被后面的用例读到。"""
    yield
    if not _created:
        return
    with engine.begin() as conn:
        for cid in list(_created):
            conn.execute(text("DELETE FROM chat_attachments WHERE conversation_id = :c"), {"c": cid})
            conn.execute(text("DELETE FROM chat_messages WHERE conversation_id = :c"), {"c": cid})
            conn.execute(text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid})
            conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
    _created.clear()


def _contents(frames: list[str]) -> list[str]:
    """从 SSE 帧里取出 content 文本（忽略 conversation_id / [DONE]）。"""
    out = []
    for frame in frames:
        if not frame.startswith("data: ") or '"content"' not in frame:
            continue
        line = frame[len("data: ") :].strip()
        if line == "[DONE]":
            continue
        payload = json.loads(line)
        if "content" in payload:
            out.append(payload["content"])
    return out


def test_pump_first_chunk_sent_immediately_and_tail_flushed():
    """首帧必须立刻发（用户要看到出字）；最后一个不足一帧的尾巴在结束时补发。"""
    parts: list[str] = []
    stream = iter(["甲", "乙", "丙", "丁"])
    frames = list(chat._pump(stream, 1, None, parts, time.monotonic()))

    contents = _contents(frames)
    assert contents[0] == "甲", "首字不允许攒着"
    assert "".join(contents) == "甲乙丙丁", "结束前必须 flush 剩余内容"
    assert "".join(parts) == "".join(contents), "落库内容必须等于已发出的内容"


def test_pump_batches_short_chunks():
    """连续短 chunk 会被合并成更少的帧：20 个单字不该发 20 帧。"""
    parts: list[str] = []
    frames = list(chat._pump(iter(["字"] * 20), 1, None, parts, time.monotonic()))
    assert len(_contents(frames)) < 20, "攒帧没生效：每个 chunk 仍各发一帧"


def test_pump_cancel_drops_unsent_buffer():
    """取消时缓冲里没发出去的字不许落库：否则停止后会凭空多出半句。"""
    parts: list[str] = []
    cancel = threading.Event()
    cancel.set()
    frames = list(chat._pump(iter(["还没发出去"]), 1, cancel, parts, time.monotonic()))

    assert frames == []
    assert parts == [], "取消路径不得把未发送内容记进落库缓冲"


def test_stream_sends_heartbeat_while_waiting_first_token(monkeypatch, fake_model):
    """首字之前也要有字节：否则反代/浏览器空闲超时先把连接掐掉，用户只看到「转圈后失败」。"""
    from routers import chat as chat_router

    def slow_stream(model, messages):
        time.sleep(0.3)  # 模拟上游首字很慢
        yield "慢回答"

    monkeypatch.setattr(chat, "_model_stream", slow_stream)
    monkeypatch.setattr(chat_router, "STREAM_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(chat_router, "STREAM_POLL_SECONDS", 0.02)
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    body = client.post("/api/v1/chat", json={"message": "心跳测试"}).text
    match = re.search(r'"conversation_id":\s*(\d+)', body)
    assert match is not None
    _created.add(int(match.group(1)))

    assert ": ping" in body, "等首字期间必须发心跳帧"
    assert "".join(_contents(body.split("\n\n"))) == "慢回答", "心跳不能吞掉正文"
    assert body.rstrip().endswith("[DONE]"), "心跳不能破坏结束标记"


def test_user_message_persisted_even_if_stream_never_starts(monkeypatch, fake_model):
    """客户端在首包前断开时，StreamingResponse 的生成器一次都不会被迭代。

    用户消息与附件行必须在路由返回响应之前就落库，否则前端乐观渲染的那条消息
    刷新一次就消失（用户以为「白打了一段话」）。
    """
    from routers import chat as chat_router
    from schemas.chat import ChatIn
    from sqlmodel import Session

    from models import ChatMessage, Conversation

    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    # 故意只构造响应、不迭代 body：模拟「客户端在建连后立刻断开」
    response = chat_router.chat(request=None, payload=ChatIn(message="首包前断开"), user_id=None)
    assert response is not None

    with Session(engine) as session:
        conv = session.exec(select(Conversation).order_by(Conversation.id.desc())).first()
        assert conv is not None, "用户消息对应的会话必须已经建好"
        _created.add(int(conv.id))
        roles = [
            row.role
            for row in session.exec(
                select(ChatMessage)
                .where(ChatMessage.conversation_id == conv.id)
                .order_by(ChatMessage.id)
            ).all()
        ]
    assert roles == ["user"], "生成器没被迭代时，用户消息也必须已经落库"


def test_answer_persisted_before_done_frame(monkeypatch, fake_model):
    """[DONE] 发出时库里的回答必须已经写完。

    前端收到 [DONE] 就停转圈；如果落库排在响应结束之后，用户立刻刷新/切会话
    会看到「回答不见了」，几秒后又出现。
    """
    from sqlmodel import Session

    from models import ChatMessage

    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    cid = None
    checked = False
    with client.stream("POST", "/api/v1/chat", json={"message": "先落库"}) as resp:
        for raw in resp.iter_lines():
            line = raw.strip()
            if line.startswith("data: ") and '"conversation_id"' in line:
                cid = int(json.loads(line[6:])["conversation_id"])
                _created.add(cid)
            if line == "data: [DONE]":
                assert cid is not None
                with Session(engine) as session:
                    roles = [
                        row.role
                        for row in session.exec(
                            select(ChatMessage).where(ChatMessage.conversation_id == cid)
                        ).all()
                    ]
                assert roles == ["user", "assistant"], "收到 [DONE] 时回答必须已经落库"
                checked = True
    assert checked, "流里必须有 [DONE]"


def test_regenerate_without_model_does_not_add_question(monkeypatch, fake_model):
    """模型不可用时点「重新生成」：只回中文错误，历史里不能多出一条一模一样的提问。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    created = client.post("/api/v1/chat", json={"message": "同一句话"}).text
    match = re.search(r'"conversation_id":\s*(\d+)', created)
    assert match is not None
    cid = int(match.group(1))
    _created.add(cid)

    before = client.get(f"/api/v1/conversations/{cid}/messages").json()
    assert [item["role"] for item in before] == ["user", "assistant"]

    # 模型全部不可用：此时 _resolve_error 命中「暂无可用模型」分支
    monkeypatch.setattr(ai, "MODELS", {})
    resp = client.post(
        "/api/v1/chat",
        json={"message": "同一句话", "conversation_id": cid, "regenerate": True},
    )
    assert resp.status_code == 200
    assert "暂无可用模型" in resp.text

    after = client.get(f"/api/v1/conversations/{cid}/messages").json()
    assert [item["role"] for item in after] == ["user", "assistant"], "重新生成不该新增提问"
    assert [item["content"] for item in after] == [item["content"] for item in before]
