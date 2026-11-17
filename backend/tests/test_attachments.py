"""附件持久化测试：落盘、消息挂附件、正文与原文读取、随会话删除、越权/丢失 404。"""
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import core.ai as ai
from core import attachments
from core.database import engine
from main import app

client = TestClient(app)

# 本文件创建的会话 id，用例结束统一清理（附件行随之删除）
_created: set[int] = set()


@pytest.fixture(autouse=True)
def _isolated_upload_dir(tmp_path, monkeypatch):
    """附件落到临时目录：不污染 backend/data/uploads，也保证文件断言可查。"""
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
                conn.execute(text("DELETE FROM chat_messages WHERE conversation_id = :c"), {"c": cid})
                conn.execute(text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid})
                conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        _created.clear()


def _upload(filename: str, data: bytes, message: str, monkeypatch, fake_model):
    """发一次上传对话，登记会话待清理，返回响应。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post(
        "/api/v1/chat_upload",
        files={"file": (filename, data, "application/octet-stream")},
        data={"message": message},
    )
    for match in re.finditer(r'"conversation_id":\s*(\d+)', resp.text):
        _created.add(int(match.group(1)))
    return resp


def _conversation_id(resp) -> int:
    return int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))


def test_text_attachment_persisted_and_readable(monkeypatch, fake_model):
    """正向：txt 落盘 + 消息挂附件；正文与原文都能取回。"""
    body = "项目结论：明天上线".encode("utf-8")
    resp = _upload("notes.txt", body, "结论是什么", monkeypatch, fake_model)
    assert resp.status_code == 200
    messages = client.get(f"/api/v1/conversations/{_conversation_id(resp)}/messages").json()
    items = messages[0]["attachments"]
    assert len(items) == 1
    assert items[0]["name"] == "notes.txt"
    assert items[0]["kind"] == "text"
    assert items[0]["mime"] == "text/plain"
    assert items[0]["size"] == len(body)

    aid = items[0]["id"]
    raw = client.get(f"/api/v1/attachments/{aid}")
    assert raw.status_code == 200
    assert raw.content == body
    assert raw.headers["content-type"].startswith("text/plain")

    detail = client.get(f"/api/v1/attachments/{aid}/text").json()
    assert "项目结论：明天上线" in detail["text"]
    assert detail["truncated"] is False


def test_image_attachment_served_inline(monkeypatch, fake_model):
    """正向：图片按自身 mime 返回，供灯箱直接显示。"""
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    resp = _upload("cat.png", png, "这是什么", monkeypatch, fake_model)
    items = client.get(f"/api/v1/conversations/{_conversation_id(resp)}/messages").json()[0][
        "attachments"
    ]
    assert items and items[0]["kind"] == "image"
    assert items[0]["mime"] == "image/png"
    raw = client.get(f"/api/v1/attachments/{items[0]['id']}")
    assert raw.status_code == 200
    assert raw.content == png
    assert raw.headers["content-type"] == "image/png"


def test_attachment_removed_with_conversation(monkeypatch, fake_model):
    """删除会话：附件记录与磁盘文件一起清掉。"""
    resp = _upload("gone.txt", b"body", "看这个", monkeypatch, fake_model)
    cid = _conversation_id(resp)
    aid = client.get(f"/api/v1/conversations/{cid}/messages").json()[0]["attachments"][0]["id"]
    path = attachments.upload_dir() / attachments.get_row(aid).stored_path
    assert path.exists()

    assert client.delete(f"/api/v1/conversations/{cid}").status_code == 200
    assert client.get(f"/api/v1/attachments/{aid}").status_code == 404
    assert not path.exists()
    _created.discard(cid)


def test_missing_file_returns_404(monkeypatch, fake_model):
    """记录在但文件被手动删掉：404 中文，不是 500。"""
    resp = _upload("lost.txt", b"body", "看这个", monkeypatch, fake_model)
    aid = client.get(f"/api/v1/conversations/{_conversation_id(resp)}/messages").json()[0][
        "attachments"
    ][0]["id"]
    attachments.resolve_path(attachments.get_row(aid)).unlink()
    got = client.get(f"/api/v1/attachments/{aid}")
    assert got.status_code == 404
    assert "附件文件已不存在" in got.json()["detail"]


def test_unknown_attachment_returns_404():
    """错误路径：不存在的附件 id 404 中文。"""
    got = client.get("/api/v1/attachments/999999")
    assert got.status_code == 404
    assert "附件不存在" in got.json()["detail"]


def test_same_content_stored_once():
    """同一份内容上传两次：磁盘只留一份（按 sha256 去重），两条记录指向同一文件。"""
    data = "重复内容".encode("utf-8")
    block = {"kind": "text", "mime": "text/plain", "text": "重复内容"}
    attachments.save_upload(data, "a.txt", block)
    attachments.save_upload(data, "b.txt", block)
    assert len(list(attachments.upload_dir().glob("*/*"))) == 1


def test_same_content_stored_once_keeps_complete_file():
    """同 sha 写两次：第二次不重写，文件内容仍完整，且不残留 .tmp。"""
    data = "完整内容".encode("utf-8") * 32
    block = {"kind": "text", "mime": "text/plain", "text": "完整内容"}
    first = attachments.save_upload(data, "same.txt", block)
    path = attachments.upload_dir() / first["stored_path"]
    assert path.read_bytes() == data
    mtime = path.stat().st_mtime_ns

    second = attachments.save_upload(data, "same.txt", block)
    assert second["stored_path"] == first["stored_path"]
    assert path.read_bytes() == data, "第二次不该重写，更不该写坏"
    assert path.stat().st_mtime_ns == mtime, "同 sha 不应重复落盘"
    assert not list(path.parent.glob("*.tmp")), "原子写的临时文件必须清理干净"


def test_atomic_write_failure_leaves_no_truncated_file(monkeypatch):
    """原子写失败（模拟 replace 时被杀）：磁盘上不能出现截断的最终文件。"""
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 128
    block = {"kind": "image", "mime": "image/png"}

    def _boom(src, dst):
        raise OSError("模拟写入时进程被中断")

    monkeypatch.setattr(attachments.os, "replace", _boom)
    with pytest.raises(OSError):
        attachments.save_upload(data, "half.png", block)
    root = attachments.upload_dir()
    assert not list(root.glob("*/*.png")), "最终文件不该以截断状态存在"
    assert not list(root.glob("*/*.tmp")), "失败路径也要清掉临时文件"


def test_cleanup_orphans_only_removes_old_unreferenced(tmp_path):
    """孤儿清理：只删「数据库无引用 + 超过 7 天」的文件，新文件一律不动。"""
    import os
    import time

    root = attachments.upload_dir()
    old_dir = root / "aa"
    old_dir.mkdir(parents=True, exist_ok=True)
    old_file = old_dir / "orphan.md"
    old_file.write_text("很久以前留下的", encoding="utf-8")
    stale = time.time() - 8 * 86400
    os.utime(old_file, (stale, stale))

    fresh_file = root / "bb"
    fresh_file.mkdir(parents=True, exist_ok=True)
    (fresh_file / "new.md").write_text("刚写入的", encoding="utf-8")

    assert attachments.cleanup_orphans() == 1
    assert not old_file.exists()
    assert (fresh_file / "new.md").exists(), "新文件不能删，可能正在上传"


def test_upload_dir_is_namespaced_by_backend(monkeypatch, tmp_path):
    """附件根必须带「库身份」：只按 sqlite/mysql 分时，本地与远程 MySQL 会互相误删。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("DB_BACKEND", "sqlite")
    assert attachments.upload_dir() == tmp_path / "sqlite"
    assert attachments.legacy_upload_root() == tmp_path

    monkeypatch.setenv("DB_BACKEND", "mysql")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "3306")
    monkeypatch.setenv("DB_NAME", "suixinwenda")
    assert attachments.upload_dir() == tmp_path / "mysql-127-0-0-1-3306-suixinwenda"

    # 换一台远程 MySQL：目录必须跟着变，否则两个库的附件互相被当孤儿删
    monkeypatch.setenv("DB_HOST", "10.0.0.9")
    assert attachments.upload_dir() == tmp_path / "mysql-10-0-0-9-3306-suixinwenda"


def test_migrate_legacy_uploads_moves_only_referenced_files(monkeypatch, fake_model, tmp_path):
    """升级后第一次启动：旧平铺结构的文件按「当前库引用集」搬进后端目录，重复执行幂等。"""
    resp = _upload("旧图.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, "旧图", monkeypatch, fake_model)
    assert resp.status_code == 200

    current = list(attachments.upload_dir().glob("*/*"))
    assert len(current) == 1
    rel = current[0].relative_to(attachments.upload_dir())

    # 手工搬回旧结构，模拟升级前的磁盘状态
    legacy = attachments.legacy_upload_root() / rel
    legacy.parent.mkdir(parents=True, exist_ok=True)
    current[0].replace(legacy)
    assert not (attachments.upload_dir() / rel).exists()

    result = attachments.migrate_legacy_uploads()
    assert result["moved"] == 1, "当前库引用到的文件必须搬过去，否则历史附件全部读不到"
    assert result["failed"] == 0
    assert (attachments.upload_dir() / rel).is_file()
    assert not legacy.exists()

    again = attachments.migrate_legacy_uploads()
    assert again == {"moved": 0, "skipped": 0, "failed": 0}, "重复执行必须是无操作"


def test_move_referenced_keeps_source_when_copying(tmp_path):
    """上一版按后端名分目录：同一目录下可能躺着另一个 MySQL 库的附件，只能复制不能搬走。"""
    source = tmp_path / "mysql"
    target = tmp_path / "mysql-10-0-0-9-3306-suixinwenda"
    (source / "ab").mkdir(parents=True)
    (source / "ab" / "f.md").write_text("内容", encoding="utf-8")

    result = attachments._move_referenced(source, target, {"ab/f.md"}, True)

    assert result == {"moved": 1, "skipped": 0, "failed": 0}
    assert (source / "ab" / "f.md").is_file(), "复制模式必须保留源文件"
    assert (target / "ab" / "f.md").read_text(encoding="utf-8") == "内容"


def test_move_referenced_moves_when_keep_source_false(tmp_path):
    """更老的平铺结构是「搬」：它不属于任何库，留在原地只会被当成孤儿。"""
    source = tmp_path / "flat"
    target = tmp_path / "sqlite"
    (source / "ab").mkdir(parents=True)
    (source / "ab" / "f.md").write_text("内容", encoding="utf-8")

    result = attachments._move_referenced(source, target, {"ab/f.md"}, False)

    assert result["moved"] == 1
    assert not (source / "ab" / "f.md").exists()
    assert (target / "ab" / "f.md").is_file()


def test_move_referenced_skips_existing_target_and_missing_source(tmp_path):
    """幂等：目标已存在、源已搬走、目录根本不存在，三种情况都不该报错也不该计数为 moved。"""
    source = tmp_path / "legacy"
    target = tmp_path / "scope"
    (source / "ab").mkdir(parents=True)
    (source / "ab" / "same.md").write_text("src", encoding="utf-8")
    (target / "ab").mkdir(parents=True)
    (target / "ab" / "same.md").write_text("dst", encoding="utf-8")

    result = attachments._move_referenced(source, target, {"ab/same.md", "ab/gone.md"}, False)
    assert result == {"moved": 0, "skipped": 1, "failed": 0}
    assert (target / "ab" / "same.md").read_text(encoding="utf-8") == "dst", "目标已有不许覆盖"

    assert attachments._move_referenced(tmp_path / "nope", target, {"ab/x.md"}, False) == {
        "moved": 0,
        "skipped": 0,
        "failed": 0,
    }


def test_cleanup_orphans_ignores_other_backend_dir(monkeypatch, tmp_path):
    """另一个后端的附件目录不归本库管：再老、再没引用也不能删。"""
    import os
    import time

    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("DB_BACKEND", "sqlite")
    other = tmp_path / "mysql" / "aa"
    other.mkdir(parents=True, exist_ok=True)
    keep = other / "keep.md"
    keep.write_text("另一个库的附件", encoding="utf-8")
    stale = time.time() - 30 * 86400
    os.utime(keep, (stale, stale))

    attachments.cleanup_orphans()
    assert keep.exists(), "跨后端的附件不能被当成孤儿"


def test_plain_message_has_empty_attachment_list(monkeypatch, fake_model):
    """普通文本对话：messages 里 attachments 是空数组，前端无需分支判断字段缺失。

    必须注入 fake_model：没有可用模型时 /chat 会在建会话之前就返回错误
    （见 test_chat.py 的「没有模型时别建会话」），本用例拿不到 conversation_id。
    靠本机环境变量里的真 Key 让它通过，等于让测试依赖外部网络与付费额度。
    """
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post("/api/v1/chat", json={"message": "你好"})
    for match in re.finditer(r'"conversation_id":\s*(\d+)', resp.text):
        _created.add(int(match.group(1)))
    cid = _conversation_id(resp)
    messages = client.get(f"/api/v1/conversations/{cid}/messages").json()
    assert all(item["attachments"] == [] for item in messages)
