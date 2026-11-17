"""流式对话接口测试：假模型替身（不发真实网络请求），覆盖正向与错误路径。"""
import json
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import core.ai as ai
from core import history
from core.database import engine
from main import app
from schemas.chat import MAX_MESSAGE_LENGTH

client = TestClient(app)

# 本文件创建过的会话 id（chat 会落库），测试结束统一清理
_created_conversations: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    """每个用例结束后删除本文件创建的会话与消息。"""
    yield
    if _created_conversations:
        with engine.begin() as conn:
            for cid in list(_created_conversations):
                # SQLite 会复用被删掉的 id：附件行不清干净，下个用例的新会话会「继承」旧附件
                conn.execute(
                    text("DELETE FROM chat_attachments WHERE conversation_id = :c"),
                    {"c": cid},
                )
                conn.execute(
                    text("DELETE FROM chat_messages WHERE conversation_id = :c"),
                    {"c": cid},
                )
                conn.execute(text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid})
                conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        _created_conversations.clear()


def _register_conversations(body: str) -> None:
    """把 SSE 正文里出现的 conversation_id 全部登记进待清理集合。"""
    for match in re.finditer(r'"conversation_id":\s*(\d+)', body):
        _created_conversations.add(int(match.group(1)))


def test_chat_stream_ok(monkeypatch, fake_model):
    """正向：SSE 头正确、含 content 载荷与 [DONE] 结束标记。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post("/api/v1/chat", json={"message": "打个招呼"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["cache-control"] == "no-cache"
    assert resp.headers["x-accel-buffering"] == "no"
    body = resp.text
    _register_conversations(body)
    assert '"content"' in body
    # 流末尾必发 conversation_id 载荷
    assert re.search(r'"conversation_id":\s*\d+', body)
    assert "data: [DONE]" in body


def test_chat_content_is_plain_chinese(monkeypatch, fake_model):
    """SSE 中文不转义（ensure_ascii=False）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post("/api/v1/chat", json={"message": "中文测试"})
    _register_conversations(resp.text)
    assert "你" in resp.text
    assert "\\u" not in resp.text


def test_chat_empty_message():
    """错误路径：空消息 422 + 中文 detail。"""
    resp = client.post("/api/v1/chat", json={"message": "   "})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert isinstance(detail, list)
    assert "不能为空" in detail[0]["msg"]


def test_chat_too_long_message():
    """错误路径：超 4000 字 422 + 中文提示（上限）。"""
    resp = client.post("/api/v1/chat", json={"message": "字" * (MAX_MESSAGE_LENGTH + 1)})
    assert resp.status_code == 422
    assert "不能超过" in resp.json()["detail"][0]["msg"]


def test_chat_no_model_returns_chinese_error(monkeypatch):
    """无可用模型：SSE 内发中文 error 并 [DONE]，状态仍 200 不崩。"""
    monkeypatch.setattr(ai, "MODELS", {})
    resp = client.post("/api/v1/chat", json={"message": "随便聊"})
    _register_conversations(resp.text)
    assert resp.status_code == 200
    assert "暂无可用模型" in resp.text
    assert "data: [DONE]" in resp.text


def test_chat_no_model_does_not_create_conversation(monkeypatch):
    """无可用模型时不新建会话，避免列表里堆出永远没有回复的僵尸对话。"""
    monkeypatch.setattr(ai, "MODELS", {})
    before = len(client.get("/api/v1/conversations").json())
    resp = client.post("/api/v1/chat", json={"message": "没有模型时别建会话"})
    assert resp.status_code == 200
    assert "conversation_id" not in resp.text
    after = len(client.get("/api/v1/conversations").json())
    assert after == before


def test_chat_model_name_too_long():
    """错误路径：模型名超长 422（防超长字符串进日志/错误文案）。"""
    resp = client.post("/api/v1/chat", json={"message": "hi", "model": "m" * 60})
    assert resp.status_code == 422


def test_chat_finish_failure_keeps_done(monkeypatch, fake_model):
    """落库失败也要把 error / conversation_id / [DONE] 收尾发出去，前端不能一直转圈。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    def _boom(*_args, **_kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(history, "finish_exchange", _boom)
    resp = client.post("/api/v1/chat", json={"message": "落库会失败的一问"})
    _register_conversations(resp.text)
    assert resp.status_code == 200
    assert "data: [DONE]" in resp.text


def test_chat_error_text_is_fixed(monkeypatch):
    """生成失败的对外文案固定为中文提示，不回传内部异常原文。"""
    class _Boom:
        """任何调用都抛异常，模拟上游模型故障（异常原文含内部细节）。"""

        def stream(self, *_args, **_kwargs):
            raise RuntimeError("upstream 500 secret-token-abc")

        def invoke(self, *_args, **_kwargs):
            raise RuntimeError("upstream 500 secret-token-abc")

    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": _Boom()})
    resp = client.post("/api/v1/chat", json={"message": "会失败的一问"})
    _register_conversations(resp.text)
    assert resp.status_code == 200
    assert "生成失败" in resp.text
    assert "secret-token-abc" not in resp.text


def test_chat_unknown_model_error():
    """指定不存在的模型：SSE 内发固定中文 error + [DONE]，不 500、不回显模型名、不建会话。"""
    before = len(client.get("/api/v1/conversations").json())
    resp = client.post(
        "/api/v1/chat", json={"message": "hi", "model": "not-exists-model"}
    )
    _register_conversations(resp.text)
    assert resp.status_code == 200
    assert "暂无可用模型" in resp.text
    assert "not-exists-model" not in resp.text
    assert "data: [DONE]" in resp.text
    assert len(client.get("/api/v1/conversations").json()) == before


def test_chat_sends_conversation_id_before_content(monkeypatch, fake_model):
    """会话 id 在首字之前下发且只发一次：左侧列表能立刻置顶，不必等模型答完。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post("/api/v1/chat", json={"message": "先给会话 id"})
    body = resp.text
    _register_conversations(body)
    id_at = body.find('"conversation_id"')
    content_at = body.find('"content"')
    assert id_at >= 0 and content_at >= 0
    assert id_at < content_at
    assert body.count('"conversation_id"') == 1


def test_chat_cancel_before_first_chunk_keeps_no_reply(monkeypatch, fake_model):
    """停止发生在首字前：一个字都不该产出，也不该事后补出一条 assistant 消息。

    这正是「点停止时是空的，切回会话内容又冒出来」的回归用例。
    """
    import threading

    from core.chat import stream_reply

    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    stop = threading.Event()
    stop.set()
    events = list(stream_reply("还没出字就停止", cancel_event=stop))
    body = "".join(events)
    _register_conversations(body)
    assert '"content"' not in body
    assert "data: [DONE]" in body
    match = re.search(r'"conversation_id":\s*(\d+)', body)
    assert match is not None
    messages = client.get(f"/api/v1/conversations/{match.group(1)}/messages").json()
    assert [item["role"] for item in messages] == ["user"]


def test_chat_cancel_keeps_only_sent_part(monkeypatch, fake_model):
    """停止发生在已出字之后：只保留停止前真正发出去的片段，不再继续往下生成。"""
    from core.chat import stream_reply

    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    class _CancelAfterFirstChunk:
        """第一次问「停了吗」答没停，之后一律答停了（模拟首字到达后用户点停止）。"""

        def __init__(self):
            self.probes = 0

        def is_set(self):
            self.probes += 1
            return self.probes > 1

    events = list(stream_reply("先答一段再停", cancel_event=_CancelAfterFirstChunk()))
    body = "".join(events)
    _register_conversations(body)
    sent = "".join(
        json.loads(line[len("data: ") :])["content"]
        for line in body.split("\n")
        if line.startswith("data: ") and '"content"' in line
    )
    assert sent, "停止前已发出的片段必须保留"
    match = re.search(r'"conversation_id":\s*(\d+)', body)
    assert match is not None
    messages = client.get(f"/api/v1/conversations/{match.group(1)}/messages").json()
    # 落库内容 == 停止前发出去的片段：不多不少，不会偷偷补全整段回答
    replies = [item["content"] for item in messages if item["role"] == "assistant"]
    assert replies == [sent]
