"""对话链路的上下文来源：db 直连、本轮多图全量、checkpoint 降级分支仍带附件。"""
import base64
import re

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage
from sqlalchemy import text

import core.ai as ai
from core import chat
from core.database import engine
from main import app

client = TestClient(app)

# 1x1 PNG：够走「图片 → base64 → 多模态块」整条链路
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)

_created: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    """每个用例结束后清理本文件创建的会话、消息、附件与摘要。"""
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


def _cid(body: str) -> int:
    match = re.search(r'"conversation_id":\s*(\d+)', body)
    assert match is not None, f"SSE 未返回 conversation_id：{body}"
    cid = int(match.group(1))
    _created.add(cid)
    return cid


def _image_count(message) -> int:
    content = message.content
    if not isinstance(content, list):
        return 0
    return sum(1 for part in content if isinstance(part, dict) and part.get("type") == "image_url")


def _texts(messages: list) -> list[str]:
    out: list[str] = []
    for message in messages:
        content = message.content
        if isinstance(content, list):
            out.append(
                "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
            )
        else:
            out.append(str(content))
    return out


def test_chat_regenerate_uses_db_context(monkeypatch, fake_model):
    """重新生成：messages 最后一轮只有 user，同一句提问只出现一次。"""
    captured: dict = {}

    def _capture(model, messages):
        captured["messages"] = messages
        yield "好的"

    monkeypatch.setattr(chat, "_model_stream", _capture)
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    first = client.post("/api/v1/chat", json={"message": "同一句话"})
    cid = _cid(first.text)

    resp = client.post(
        "/api/v1/chat",
        json={"message": "同一句话", "conversation_id": cid, "regenerate": True},
    )
    assert resp.status_code == 200

    messages = captured["messages"]
    assert isinstance(messages[-1], HumanMessage), "重新生成时本轮只有提问，旧回答要被排除"
    assert _texts(messages).count("同一句话") == 1, "提问不能重复追加"


def test_chat_upload_keeps_all_current_images(monkeypatch, fake_model, tmp_path):
    """本轮 7 张图（超过 IMAGE_MAX_COUNT=6）全部进入模型输入。

    IMAGE_MAX_COUNT 只约束「历史重放」，本轮附件要全量带给模型，所以张数必须取常量 +1：
    常量从 4 调到 6 之后，原来写死的 5 张已经不再「超过上限」，用例会退化成永远成立的断言。
    """
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    captured: dict = {}

    def _capture(model, messages):
        captured["messages"] = messages
        yield "好的"

    monkeypatch.setattr(chat, "_model_stream", _capture)
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    files = [("files", (f"图{index}.png", TINY_PNG, "image/png")) for index in range(7)]
    resp = client.post("/api/v1/chat_upload", data={"message": "看看这些"}, files=files)
    assert resp.status_code == 200
    _cid(resp.text)

    last = captured["messages"][-1]
    assert _image_count(last) == 7, "本轮附件不受 IMAGE_MAX_COUNT 约束"
    assert "看看这些" in _texts([last])[0]


def test_regenerate_rebuilds_attachment_from_db(monkeypatch, fake_model, tmp_path):
    """重新生成：附件不再由调用方传，而是 load_context 从数据库回读成多模态块。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    captured: dict = {}

    def _capture(model, messages):
        captured["messages"] = messages
        yield "看图"

    monkeypatch.setattr(chat, "_model_stream", _capture)
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    first = client.post(
        "/api/v1/chat_upload",
        data={"message": "看图"},
        files=[("files", ("a.png", TINY_PNG, "image/png"))],
    )
    cid = _cid(first.text)

    resp = client.post(
        "/api/v1/chat",
        json={"message": "看图", "conversation_id": cid, "regenerate": True},
    )
    assert resp.status_code == 200
    messages = captured["messages"]
    assert _image_count(messages[-1]) == 1, "重新生成时上一问的图片要从库里回读"
    assert "看图" in _texts([messages[-1]])[0]
