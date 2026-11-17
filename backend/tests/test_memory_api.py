"""对话历史弹窗接口：与 load_context 同源、图片元数据、查库异常不 500。"""
import base64
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlmodel import Session

import core.ai as ai
from core import context
from core.database import engine
from main import app
from models import Conversation
from routers import conversations as conversations_router

client = TestClient(app)

# 1x1 合法 PNG：够走「上传 → 落盘 → 上下文重建」整条链路
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


def _conversation() -> int:
    with Session(engine) as session:
        conv = Conversation(title="记忆弹窗测试", add_time=0, update_time=0)
        session.add(conv)
        session.commit()
        session.refresh(conv)
        cid = int(conv.id)
    _created.add(cid)
    return cid


def _cid(body: str) -> int:
    match = re.search(r'"conversation_id":\s*(\d+)', body)
    assert match is not None, f"SSE 未返回 conversation_id：{body}"
    cid = int(match.group(1))
    _created.add(cid)
    return cid


def _expected(messages: list) -> list[dict]:
    """按接口口径把上下文消息转成 {role, content}，用于比对弹窗内容。"""
    out: list[dict] = []
    for message in messages:
        content = message.content
        if isinstance(content, list):
            text_value = "".join(
                str(part.get("text") or "") for part in content if isinstance(part, dict)
            )
        else:
            text_value = str(content or "")
        role = "user" if message.type == "human" else "assistant" if message.type == "ai" else "system"
        out.append({"role": role, "content": text_value})
    return out


def test_memory_endpoint_matches_context(monkeypatch, fake_model):
    """db 模式下弹窗内容与 load_context 完全一致（条数与角色序列）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    first = client.post("/api/v1/chat", json={"message": "第一问"})
    cid = _cid(first.text)
    client.post("/api/v1/chat", json={"message": "第二问", "conversation_id": cid})

    resp = client.get(f"/api/v1/conversations/{cid}/memory")
    assert resp.status_code == 200
    data = resp.json()["messages"]

    expected = _expected(context.load_context(cid))
    assert [item["role"] for item in data] == [item["role"] for item in expected]
    assert [item["content"] for item in data] == [item["content"] for item in expected]
    assert [item["role"] for item in data] == ["user", "assistant", "user", "assistant"]


def test_memory_endpoint_reports_image_meta(monkeypatch, fake_model, tmp_path):
    """弹窗要能看出哪条消息带过图、以及模型这一轮是否真的重放了它。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})

    first = client.post(
        "/api/v1/chat_upload",
        data={"message": "看图"},
        files=[("files", ("a.png", TINY_PNG, "image/png"))],
    )
    cid = _cid(first.text)

    # 图在重放窗口内：元数据标明 replayed=True
    data = client.get(f"/api/v1/conversations/{cid}/memory").json()["messages"]
    assert data[0]["role"] == "user"
    assert data[0]["images"] == [{"id": data[0]["images"][0]["id"], "name": "a.png", "replayed": True}]
    assert data[0]["images"][0]["id"] > 0

    # 再聊 5 轮（共 6 轮）：这张图超出 IMAGE_ROUNDS=5 窗口，降级为占位，但缩略图元数据仍保留
    for question in ("第二问", "第三问", "第四问", "第五问", "第六问"):
        client.post("/api/v1/chat", json={"message": question, "conversation_id": cid})

    data = client.get(f"/api/v1/conversations/{cid}/memory").json()["messages"]
    assert data[0]["images"][0]["replayed"] is False
    assert data[0]["images"][0]["name"] == "a.png"
    assert "[图片：a.png]" in data[0]["content"]


def test_memory_endpoint_survives_db_error(monkeypatch):
    """db 模式下查库异常：返回 200 + 空列表 + degraded，不 500。

    degraded 是给前端的区分信号：只回空列表的话，库坏了界面显示「还没有消息」，
    用户会以为对话被清空，真正原因永远不会被报出来。
    """

    def _boom(*_args, **_kwargs):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    monkeypatch.setattr(conversations_router.context, "load_context_view", _boom)
    cid = _conversation()

    resp = client.get(f"/api/v1/conversations/{cid}/memory")

    assert resp.status_code == 200
    assert resp.json() == {"messages": [], "degraded": True}
