"""附件物理文件的孤儿判定：删会话时「无后缀落盘」的那份也必须被删掉。

真实上传路径要求后缀在白名单内，但 `tools/restore` 与单元调用可以喂进「文件名里没有点」的形态。
删除逻辑早先用 `glob("{sha}.*")` 找文件，这种形态永远匹配不到，
表现为「删了会话，磁盘上那份文件还在」——只能等 7 天后的孤儿清理兜底。
"""
import hashlib
import time

import pytest
from sqlalchemy import text
from sqlmodel import Session

from core import attachments
from core.database import engine
from models import ChatAttachment, Conversation

# 本文件创建的会话 id：结束即清，避免污染其它用例
_created: list[int] = []


@pytest.fixture(autouse=True)
def _isolated_upload_dir(tmp_path, monkeypatch):
    """附件落到临时目录：不碰 backend/data/uploads，文件断言也可查。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    yield


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    yield
    if _created:
        with engine.begin() as conn:
            for cid in list(_created):
                conn.execute(
                    text("DELETE FROM chat_attachments WHERE conversation_id = :c"), {"c": cid}
                )
                conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        _created.clear()


def test_delete_by_conversation_removes_file_without_extension():
    """无后缀的落盘文件必须进孤儿清单：否则会话删了、文件还在。"""
    sha = hashlib.sha256(b"bare-file").hexdigest()
    rel = f"{sha[:2]}/{sha}"  # 文件名里没有点 → 落盘名无扩展名
    target = attachments.upload_dir() / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"bare-file")
    assert target.exists()

    now = int(time.time())
    with Session(engine) as session:
        conversation = Conversation(user_id=None, title="无后缀附件", add_time=now, update_time=now)
        session.add(conversation)
        session.flush()
        cid = int(conversation.id)
        _created.append(cid)
        session.add(
            ChatAttachment(
                message_id=0,
                conversation_id=cid,
                name="README",
                mime="text/plain",
                size=9,
                kind="text",
                sha256=sha,
                stored_path=rel,
                add_time=now,
            )
        )
        session.commit()
        orphans = attachments.delete_by_conversation(session, cid)
        session.commit()

    assert target in orphans
    attachments.remove_files(orphans)
    assert not target.exists()
