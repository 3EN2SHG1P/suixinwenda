"""上下文构建与轮次游标：上下文只来自数据库，配对 / 预算 / 附件 / 降级逐条验证。"""
import base64
import logging
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlmodel import Session

from core import attachments, context, history
from core.context import load_context, round_cursor
from core.database import engine
from models import ChatMessage, Conversation

# 本文件创建过的会话 id，用例结束统一清理（含摘要表）
_created: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    """每个用例结束后删除本文件创建的会话、消息、附件与摘要。"""
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
    """建一个空会话（匿名），返回 id。"""
    with Session(engine) as session:
        conv = Conversation(title="上下文测试", add_time=0, update_time=0)
        session.add(conv)
        session.commit()
        session.refresh(conv)
        cid = int(conv.id)
    _created.add(cid)
    return cid


def _add(cid: int, role: str, content: str, *, question: str | None = None, superseded: int = 0) -> int:
    """插一条消息；question=None 模拟改造前的老数据。"""
    with Session(engine) as session:
        row = ChatMessage(
            conversation_id=cid,
            role=role,
            content=content,
            question=question,
            superseded=superseded,
            add_time=0,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        mid = int(row.id)
    return mid


def _round(cid: int, question: str, answer: str) -> int:
    """插一轮完整问答，返回该轮 user 消息 id。"""
    uid = _add(cid, "user", question, question=question)
    _add(cid, "assistant", answer)
    return uid


def _attach(cid: int, message_id: int, name: str, kind: str, text_excerpt: str = "") -> None:
    """给一条消息挂附件：图片落真实文件（rebuild_block 会回读），文档只存抽取正文。"""
    data = f"bytes-of-{name}".encode("utf-8")
    block = (
        {
            "kind": "image",
            "mime": "image/png",
            "size": len(data),
            "b64": base64.b64encode(data).decode("ascii"),
        }
        if kind == "image"
        else {"kind": "text", "mime": "text/plain", "size": len(data), "text": text_excerpt}
    )
    meta = attachments.save_upload(data, name, block)
    with Session(engine) as session:
        attachments.attach_to_message(session, message_id, cid, meta, 0)
        session.commit()


def _texts(messages: list) -> list[str]:
    """把消息内容归一成纯文本（多模态只取 text 段），便于断言。"""
    out: list[str] = []
    for message in messages:
        content = message.content
        if isinstance(content, list):
            out.append(
                "".join(
                    str(part.get("text") or "") for part in content if isinstance(part, dict)
                )
            )
        else:
            out.append(str(content))
    return out


def _image_count(message) -> int:
    """数一条消息里的图片段个数。"""
    content = message.content
    if not isinstance(content, list):
        return 0
    return sum(1 for part in content if isinstance(part, dict) and part.get("type") == "image_url")


def test_context_active_reply():
    """回退之后取上下文：最后一条 assistant 是回退后的版本，被作废的版本不出现。"""
    cid = _conversation()
    _round(cid, "第一问", "第一答")
    user_id = _add(cid, "user", "第二问", question="第二问")
    answered = _add(cid, "assistant", "旧回答")
    # 重新生成：旧回答降级，新回答顶上
    with engine.begin() as conn:
        conn.execute(text("UPDATE chat_messages SET superseded = 1 WHERE id = :i"), {"i": answered})
    _add(cid, "assistant", "新回答")

    history.revert_last_regenerate(cid, None)

    messages = load_context(cid)
    texts = _texts(messages)
    assert texts == ["第一问", "第一答", "第二问", "旧回答"]
    assert isinstance(messages[-1], AIMessage)
    assert "新回答" not in texts
    assert user_id is not None


def test_context_round_boundary():
    """中间半轮（被停止的提问）不出现；最后一条未配对的 user 必须保留。"""
    cid = _conversation()
    _round(cid, "第一问", "第一答")
    _add(cid, "user", "被停止的第二问", question="被停止的第二问")
    _round(cid, "第三问", "第三答")
    _add(cid, "user", "最后还没答的第四问", question="最后还没答的第四问")

    messages = load_context(cid)

    assert [type(item).__name__ for item in messages] == [
        "HumanMessage",
        "AIMessage",
        "HumanMessage",
        "AIMessage",
        "HumanMessage",
    ]
    assert "被停止的第二问" not in _texts(messages)
    assert isinstance(messages[-1], HumanMessage)
    assert messages[-1].content == "最后还没答的第四问"


def test_context_regenerate_excludes_current_reply():
    """重新生成：本轮 assistant 被排除、更早轮次仍在；上一轮被停止过也不丢更早轮次。"""
    cid = _conversation()
    _round(cid, "第一问", "第一答")
    _add(cid, "user", "第二问", question="第二问")
    _add(cid, "assistant", "即将作废的回答")

    messages = load_context(cid, regenerate=True)
    texts = _texts(messages)
    assert "即将作废的回答" not in texts
    assert "第一答" in texts
    assert messages[-1].content == "第二问"
    assert isinstance(messages[-1], HumanMessage)

    # 变体：上一轮被停止过（最后一条 assistant 属于更早轮次）
    cid2 = _conversation()
    _round(cid2, "A问", "A答")
    _add(cid2, "user", "被停止的B问", question="被停止的B问")
    _round(cid2, "C问", "C答")

    messages2 = load_context(cid2, regenerate=True)
    texts2 = _texts(messages2)
    assert "A答" in texts2, "更早轮次必须保留"
    assert "C答" not in texts2, "本轮回答要排除"
    assert messages2[-1].content == "C问"


def test_context_no_duplicate_current_question():
    """重新生成时同一句提问只能出现一次（本轮提问只从 DB 取）。"""
    cid = _conversation()
    _round(cid, "同一句话", "上一版回答")

    messages = load_context(cid, current_message="同一句话", regenerate=True)

    assert _texts(messages).count("同一句话") == 1


def test_context_replays_recent_image(monkeypatch, tmp_path):
    """IMAGE_ROUNDS 内历史图片仍在；本轮附件超过 IMAGE_MAX_COUNT 也全部保留。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    cid = _conversation()
    user_id = _add(cid, "user", "[上传文件] 猫.png", question="这张图是什么")
    _attach(cid, user_id, "猫.png", "image")
    _add(cid, "assistant", "是一只猫")
    _add(cid, "user", "再看看这几张", question="再看看这几张")

    blocks = [
        {"kind": "image", "mime": "image/png", "size": 10, "b64": "QUJD"} for _ in range(5)
    ]
    messages = load_context(cid, current_blocks=blocks)

    assert _image_count(messages[0]) == 1, "最近一轮的历史图片要重放"
    assert _image_count(messages[-1]) == 5, "本轮附件不受 IMAGE_MAX_COUNT 约束"

    # 超出 IMAGE_ROUNDS 的历史图片降级为文字占位
    cid2 = _conversation()
    old_id = _add(cid2, "user", "[上传文件] 老图.png", question="老图")
    _attach(cid2, old_id, "老图.png", "image")
    _add(cid2, "assistant", "老图答")
    # IMAGE_ROUNDS=5 只重放最近 5 轮（含图片自己那一轮），所以后面要跟 5 轮才把它挤出窗口
    for index in range(5):
        _round(cid2, f"后续问{index}", f"后续答{index}")

    messages2 = load_context(cid2)
    assert _image_count(messages2[0]) == 0
    assert "[图片：老图.png]" in _texts(messages2)[0]


def test_context_replays_image_at_window_edge(monkeypatch, tmp_path):
    """窗口边缘：后面跟 4 轮（合计 5 轮）时图片仍在窗口内，证明窗口确实放宽到 5 而不是 3。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    cid = _conversation()
    user_id = _add(cid, "user", "[上传文件] 边缘图.png", question="边缘图")
    _attach(cid, user_id, "边缘图.png", "image")
    _add(cid, "assistant", "边缘答")
    for index in range(4):
        _round(cid, f"后续问{index}", f"后续答{index}")

    messages = load_context(cid)
    assert _image_count(messages[0]) == 1, "5 轮窗口内的图片必须重放"
    assert "[图片：边缘图.png]" not in _texts(messages)[0]


def test_context_history_image_cache_skips_second_disk_read(monkeypatch, tmp_path):
    """同一张历史图片第二次构建上下文不再读盘：命中进程内 LRU。

    为什么值得一条用例：读盘 + base64 在「首字」之前的同步路径上，
    缓存没接上时不会报错、只会悄悄变慢，没有断言就没人发现。
    """
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    attachments._HISTORY_CACHE.clear()  # 别让其它用例留下的缓存把这条用例变成假通过
    cid = _conversation()
    user_id = _add(cid, "user", "[上传文件] 缓存图.png", question="缓存图")
    _attach(cid, user_id, "缓存图.png", "image")
    _add(cid, "assistant", "答")

    assert _image_count(load_context(cid)[0]) == 1

    reads = []
    original = Path.read_bytes

    def counting_read(self):
        reads.append(self)
        return original(self)

    monkeypatch.setattr(Path, "read_bytes", counting_read)
    second = load_context(cid)
    assert _image_count(second[0]) == 1
    assert reads == [], "第二次构建应命中缓存，不允许再读盘"


def test_context_image_total_budget_degrades_to_placeholder(monkeypatch, tmp_path):
    """极端情况：单张 4MB 的图连传 5 轮，合计超 IMAGE_TOTAL_BYTES → 只重放预算内的，其余降级。

    不许突破上限，也不许抛错：图片超预算是常态（用户可能连发截图），降级成 `[图片：文件名]` 即可。
    """
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    cid = _conversation()
    # 恰好 4MB（含 PNG 魔数）：等于 IMAGE_MAX_BYTES，单张不超限，超的是合计预算
    big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (context.IMAGE_MAX_BYTES - 8)
    block = {"kind": "image", "mime": "image/png", "size": len(big), "b64": "x"}
    meta = attachments.save_upload(big, "big.png", block)  # 同 sha 只落一份盘，省磁盘

    for index in range(5):
        user_id = _add(cid, "user", f"[上传文件] big{index}.png", question=f"第{index}问")
        with Session(engine) as session:
            attachments.attach_to_message(session, user_id, cid, meta, 0)
            session.commit()
        _add(cid, "assistant", f"第{index}答")

    messages = load_context(cid)  # 不许抛错

    texts = _texts(messages)
    replayed = sum(_image_count(message) for message in messages)
    placeholders = sum(1 for text in texts if text.startswith("[图片：big.png]"))
    assert replayed == context.IMAGE_TOTAL_BYTES // context.IMAGE_MAX_BYTES, "预算内只够放 2 张"
    assert placeholders == 5 - replayed, "超预算的必须降级为文字占位"
    assert replayed * context.IMAGE_MAX_BYTES <= context.IMAGE_TOTAL_BYTES, "不许突破合计上限"


def test_context_respects_char_budget(monkeypatch):
    """总量不超过 CONTEXT_CHAR_BUDGET：最旧轮次先被丢，最后一条提问永远保留。"""
    monkeypatch.setattr(context, "CONTEXT_CHAR_BUDGET", 200)
    cid = _conversation()
    for index in range(4):
        _round(cid, f"问题{index}" + "字" * 50, "答" * 60)
    _add(cid, "user", "最后的问题", question="最后的问题")

    messages = load_context(cid)

    total = sum(len(item) for item in _texts(messages))
    assert total <= 200
    assert isinstance(messages[-1], HumanMessage)
    assert messages[-1].content == "最后的问题"
    assert "问题0" not in "".join(_texts(messages)), "最旧轮次应先被丢掉"


def test_context_empty_question_fallback(monkeypatch, tmp_path):
    """question 为 NULL 时靠 content 兜底；有附件块时不得重复塞正文。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    cid = _conversation()
    _add(cid, "user", "[上传文件] 说明.txt\n正文内容", question=None)
    _add(cid, "assistant", "收到")

    assert load_context(cid)[0].content == "正文内容"

    cid2 = _conversation()
    user_id = _add(cid2, "user", "[上传文件] 说明.txt\n正文内容", question=None)
    _attach(cid2, user_id, "说明.txt", "text", text_excerpt="抽取正文")
    _add(cid2, "assistant", "收到")

    text_content = load_context(cid2)[0].content
    assert text_content == "抽取正文"
    assert "正文内容" not in text_content, "有附件块时不能再拿 content 兜底"

    # 老数据 + 附件全是图片：图片块没有正文，把你打的字补回来，不能只剩占位文案
    cid3 = _conversation()
    old_image = _add(cid3, "user", "[上传文件] 老图.png\n这张图上的数字是多少", question=None)
    _attach(cid3, old_image, "老图.png", "image")
    _add(cid3, "assistant", "123")

    first = load_context(cid3)[0]
    assert _image_count(first) == 1
    assert "这张图上的数字是多少" in _texts([first])[0]


def test_context_never_empty():
    """新会话首次取上下文：至少返回 1 条 HumanMessage，绝不能是空列表。"""
    cid = _conversation()

    messages = load_context(cid)

    assert len(messages) == 1
    assert isinstance(messages[0], HumanMessage)


def test_context_db_failure_uses_current_message(monkeypatch):
    """查库失败时用本轮文案降级出 1 条 HumanMessage，不动真库、不抛错。"""

    def _boom(*_args, **_kwargs):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    monkeypatch.setattr(context, "_fetch_context_data", _boom)

    messages = load_context(1, current_message="救命的一句话")

    assert len(messages) == 1
    assert isinstance(messages[0], HumanMessage)
    assert messages[0].content == "救命的一句话"


def test_start_exchange_saves_question():
    """落库时 question 存用户真正打的字，content 仍保留 [上传文件] 前缀与抽取正文。"""
    cid = history.start_exchange(None, "[上传文件] a.png\n真正的问题", None, [], question="真正的问题")
    _created.add(cid)

    with engine.connect() as conn:
        content, question = conn.execute(
            text("SELECT content, question FROM chat_messages WHERE conversation_id = :c"),
            {"c": cid},
        ).first()

    assert question == "真正的问题"
    assert content == "[上传文件] a.png\n真正的问题"


def test_round_cursor_matches_paired_rounds():
    """rounds / upto 与配对结果一致：12 轮、12+未答、中间被停止、不足 10 轮四种形态。"""
    # a) 12 轮全配对：upto = 第 3 轮 user（覆盖前 2 轮）
    cid = _conversation()
    ids = [_round(cid, f"问{i}", f"答{i}") for i in range(1, 13)]
    assert round_cursor(cid) == (12, ids[2])

    # b) 12 轮 + 第 13 轮提问未答：完整轮仍 12，upto 不变
    cid2 = _conversation()
    ids2 = [_round(cid2, f"问{i}", f"答{i}") for i in range(1, 13)]
    _add(cid2, "user", "第13问", question="第13问")
    assert round_cursor(cid2) == (12, ids2[2])

    # c) 中间一轮被停止：该半轮不计入轮数，与 load_context 丢弃它的行为一致
    cid3 = _conversation()
    ids3 = [_round(cid3, f"问{i}", f"答{i}") for i in range(1, 7)]
    _add(cid3, "user", "被停止的问题", question="被停止的问题")
    ids3 += [_round(cid3, f"问{i}", f"答{i}") for i in range(7, 13)]
    assert round_cursor(cid3) == (12, ids3[2])

    # d) 完整轮不足 10：upto 为 0，不排摘要任务
    cid4 = _conversation()
    for i in range(1, 4):
        _round(cid4, f"短问{i}", f"短答{i}")
    assert round_cursor(cid4) == (3, 0)


def test_round_cursor_gives_up_when_truncated(monkeypatch, caplog):
    """行数达到上限：返回 (0, 0) + error 日志，绝不返回近似轮数。"""
    monkeypatch.setattr(context, "ROUND_CURSOR_MAX_ROWS", 20)
    cid = _conversation()
    for index in range(1, 16):
        _round(cid, f"问{index}", f"答{index}")

    with caplog.at_level(logging.ERROR):
        result = round_cursor(cid)

    assert result == (0, 0)
    assert "round_cursor 行数达到上限" in caplog.text
