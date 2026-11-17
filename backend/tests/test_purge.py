"""一键清除测试：四张会话相关表清空、附件文件删除，但账号必须保留。

这是不可逆操作，必须有用例盯住「清了哪些」和「没清哪些」。
"""
import pytest
from sqlalchemy import create_engine
from sqlmodel import Session, SQLModel, select

from models import ChatAttachment, ChatMessage, ChatSummary, Conversation, User
from tools import purge


@pytest.fixture
def isolated_engine(monkeypatch, tmp_path):
    probe = create_engine(f"sqlite:///{(tmp_path / 'purge.db').as_posix()}")
    monkeypatch.setattr(purge, "engine", probe)
    # 附件目录也指到临时目录：否则会删到 conftest 那个共享 DATA_DIR 里的文件
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    SQLModel.metadata.create_all(probe)
    yield probe
    probe.dispose()


def _seed(engine):
    with Session(engine) as session:
        session.add(User(username="keep@test.local", password="x" * 20, nickname="keep"))
        for index in range(2):
            conv = Conversation(title=f"会话 {index}", add_time=0, update_time=0)
            session.add(conv)
            session.commit()
            session.refresh(conv)
            session.add(ChatMessage(conversation_id=conv.id, role="user", content="hi"))
            session.add(ChatSummary(conversation_id=conv.id, summary="摘要", covered_message_id=1))
            session.add(
                ChatAttachment(
                    message_id=1,
                    conversation_id=conv.id,
                    name="a.png",
                    mime="image/png",
                    kind="image",
                    sha256="x" * 64,
                    stored_path=f"aa/{index}.png",
                )
            )
        session.commit()


def test_purge_clears_session_data_and_files_but_keeps_users(isolated_engine):
    _seed(isolated_engine)
    files_dir = purge.upload_dir()
    files_dir.mkdir(parents=True, exist_ok=True)
    (files_dir / "probe.png").write_bytes(b"x")

    result = purge.purge_all()

    assert result["deleted"] == {
        "conversations": 2,
        "messages": 2,
        "summaries": 2,
        "attachments": 2,
    }
    assert result["files"] == 1
    assert purge.counts() == {"conversations": 0, "messages": 0, "summaries": 0, "attachments": 0}
    assert not list(files_dir.glob("*")), "附件文件必须一起清掉"

    with Session(isolated_engine) as session:
        assert len(session.exec(select(User)).all()) == 1, "账号不属于会话数据，必须保留"


def test_counts_works_on_empty_database(isolated_engine):
    """空库上统计不能报错（首次启动就会调它）。"""
    assert purge.counts() == {"conversations": 0, "messages": 0, "summaries": 0, "attachments": 0}


def test_purge_on_fresh_sqlite_without_tables(monkeypatch, tmp_path):
    """刚切到 SQLite 时目标位置可能只有一个空文件（连表都没有）：
    清除必须安静地报 0，而不是抛 no such table 让用户以为数据出了问题。"""
    probe = create_engine(f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}")
    monkeypatch.setattr(purge, "engine", probe)
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))

    result = purge.purge_all()

    assert result["deleted"] == {
        "conversations": 0,
        "messages": 0,
        "summaries": 0,
        "attachments": 0,
    }
    probe.dispose()
