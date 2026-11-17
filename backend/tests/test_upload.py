"""文件上传对话测试：正向落库 + 老格式/超限/坏文件/截断错误路径 + 大文件分块暂存。"""
import io
import logging
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import core.ai as ai
from core import db_info, files
from core.database import engine
from main import app

client = TestClient(app)

# 本文件创建过的会话 id，测试结束统一清理
_created_conversations: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations(tmp_path, monkeypatch):
    """每个用例结束后删除本文件创建的会话与消息；附件落到临时目录，不污染仓库。"""
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
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


def _upload(filename: str, data: bytes, message: str = "讲讲内容", monkeypatch=None, model=None):
    """发一次上传对话（model 非空时用替身模型），登记会话待清理，返回响应。"""
    if model is not None and monkeypatch is not None:
        monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": model})
    resp = client.post(
        "/api/v1/chat_upload",
        files={"file": (filename, data, "application/octet-stream")},
        data={"message": message},
    )
    for match in re.finditer(r'"conversation_id":\s*(\d+)', resp.text):
        _created_conversations.add(int(match.group(1)))
    return resp


def test_upload_multiple_files(monkeypatch, fake_model):
    """多附件：一次传两个文件，同一条用户消息挂两条附件记录，落库文本按选择顺序各占一段。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post(
        "/api/v1/chat_upload",
        files=[
            ("files", ("a.txt", "第一份内容".encode("utf-8"), "text/plain")),
            ("files", ("b.txt", "第二份内容".encode("utf-8"), "text/plain")),
        ],
        data={"message": "一起看看"},
    )
    assert resp.status_code == 200
    cid = int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))
    _created_conversations.add(cid)
    msgs = client.get(f"/api/v1/conversations/{cid}/messages").json()
    user = msgs[0]
    assert user["content"].count("[上传文件]") == 2
    assert [item["name"] for item in user["attachments"]] == ["a.txt", "b.txt"]
    assert "第一份内容" in user["content"] and "第二份内容" in user["content"]


def test_invalid_file_leaves_no_orphan(monkeypatch, tmp_path, fake_model):
    """三个文件里第三个非法：整轮拒绝，前两个不能留下孤儿附件（先全部校验、后统一落盘）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.post(
        "/api/v1/chat_upload",
        files=[
            ("files", ("a.txt", "合法内容一".encode("utf-8"), "text/plain")),
            ("files", ("b.txt", "合法内容二".encode("utf-8"), "text/plain")),
            # 后缀是 png 但内容不是图片：parse_upload 按魔数嗅探会拒
            ("files", ("c.png", b"not-an-image", "image/png")),
        ],
        data={"message": "一起看看"},
    )
    assert resp.status_code == 400
    left = [path for path in tmp_path.rglob("*") if path.is_file()]
    assert left == [], f"整轮失败不许留下任何附件文件：{left}"


def test_upload_too_many_files_422(monkeypatch, fake_model):
    """错误路径：超过单次附件数量上限 422 + 中文。"""
    from core.files import MAX_UPLOAD_FILES

    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    files = [
        ("files", (f"n{index}.txt", b"x", "text/plain")) for index in range(MAX_UPLOAD_FILES + 1)
    ]
    resp = client.post("/api/v1/chat_upload", files=files, data={"message": "太多"})
    assert resp.status_code == 422
    assert "最多上传" in resp.json()["detail"]


def test_txt_upload_saves_and_replies(monkeypatch, fake_model):
    """正向：txt 抽文本走流式；聊天记录只存 `[上传文件] 文件名` + 文本 + 问题。"""
    resp = _upload("notes.txt", "项目结论：明天上线".encode("utf-8"), "结论是什么", monkeypatch, fake_model)
    assert resp.status_code == 200
    # 逐段 content 拼接后应为替身完整回复
    assert "".join(re.findall(r'"content": "([^"]*)"', resp.text)) == "你好"
    assert "data: [DONE]" in resp.text
    cid = int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))
    msgs = client.get(f"/api/v1/conversations/{cid}/messages").json()
    user_text = msgs[0]["content"]
    assert user_text.startswith("[上传文件] notes.txt")
    assert "项目结论：明天上线" in user_text
    assert "结论是什么" in user_text


def test_image_upload_saves_filename_only(monkeypatch, fake_model):
    """图片：多模态走流式；记录里只存文件名与问题，不存图片二进制。"""
    fake_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    resp = _upload("cat.png", fake_png, "这是什么", monkeypatch, fake_model)
    assert resp.status_code == 200
    assert "".join(re.findall(r'"content": "([^"]*)"', resp.text)) == "你好"
    cid = int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))
    user_text = client.get(f"/api/v1/conversations/{cid}/messages").json()[0]["content"]
    assert user_text.startswith("[上传文件] cat.png")
    assert "这是什么" in user_text
    # 记录里不含 base64 图片数据
    assert "iVBOR" not in user_text and len(user_text) < 200


def test_png_suffix_with_text_content_rejected():
    """内容嗅探：.png 里装纯文本 → 400（unsupported 映射 400，不是 422）。"""
    resp = _upload("fake.png", "这不是图片，只是改了后缀".encode("utf-8"))
    assert resp.status_code == 400
    assert "不是有效图片" in resp.json()["detail"]


def test_real_jpeg_renamed_png_keeps_image_kind(monkeypatch, fake_model):
    """真实 JPG 改名 .png：仍按图片处理，mime 取嗅探结果 image/jpeg（不按后缀）。"""
    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 32
    resp = _upload("photo.png", jpeg, "这是什么", monkeypatch, fake_model)
    assert resp.status_code == 200
    cid = int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))
    items = client.get(f"/api/v1/conversations/{cid}/messages").json()[0]["attachments"]
    assert items and items[0]["kind"] == "image"
    assert items[0]["mime"] == "image/jpeg", "mime 必须来自内容嗅探，而不是后缀"


def test_zip_bomb_docx_rejected(monkeypatch):
    """压缩炸弹：docx 解压后超过上限 → 413 且文案含「解压后过大」（阈值可注入）。"""
    import io
    import zipfile

    import core.files as files

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"\x00" * 4096)
    body = buffer.getvalue()
    assert len(body) < 1024 * 1024, "压缩包本身很小，膨胀比才是问题"

    monkeypatch.setattr(files, "MAX_UNZIPPED_BYTES", 1024)
    resp = _upload("bomb.docx", body)
    assert resp.status_code == 413
    assert "解压后过大" in resp.json()["detail"]


def test_old_doc_rejected():
    """错误路径：.doc 老格式 400 + 中文提示另存新格式。"""
    resp = _upload("old.doc", b"\xd0\xcf\x11\xe0 old binary")
    assert resp.status_code == 400
    assert "另存为" in resp.json()["detail"]


def test_unsupported_ext_lists_supported():
    """错误路径：不支持的后缀 400 + 中文列出支持清单。"""
    resp = _upload("virus.exe", b"MZ\x90\x00")
    assert resp.status_code == 400
    assert "暂不支持该格式" in resp.json()["detail"]
    assert ".png" in resp.json()["detail"]


def test_too_large_rejected(monkeypatch):
    """错误路径：超过合计上限 413 + 中文（上限唯一源 =『MAX_TOTAL_BYTES』）。

    用 monkeypatch 把上限调小再验，避免每次跑测试都真造 30 MB 请求体。
    """
    import main

    monkeypatch.setattr(main, "MAX_TOTAL_BYTES", 1024)
    monkeypatch.setattr(main, "MULTIPART_OVERHEAD", 0)
    resp = _upload("big.txt", b"a" * 2048)
    assert resp.status_code == 413
    assert "不能超过" in resp.json()["detail"]


def test_oversize_rejected_before_parsing(monkeypatch):
    """大包在中间件按 Content-Length 就拒（不进入路由、不落临时盘）。"""
    import main
    from core.files import MAX_TOTAL_BYTES, MULTIPART_OVERHEAD

    monkeypatch.setattr(main, "MAX_TOTAL_BYTES", 1024)
    monkeypatch.setattr(main, "MULTIPART_OVERHEAD", 0)
    # 仍大于调小后的阈值，但小于真实阈值：只在中间件这一层被拦下
    body = b"a" * (1024 + 1)
    assert len(body) < MAX_TOTAL_BYTES + MULTIPART_OVERHEAD
    resp = _upload("huge.txt", body)
    assert resp.status_code == 413
    assert "不能超过" in resp.json()["detail"]


def test_upload_message_too_long_rejected():
    """错误路径：上传对话的文字也走同一套上限，超 4000 字 422（表单字段不能绕过校验）。"""
    from schemas.chat import MAX_MESSAGE_LENGTH

    resp = _upload("a.txt", b"hello", "字" * (MAX_MESSAGE_LENGTH + 1))
    assert resp.status_code == 422
    assert "不能超过" in str(resp.json()["detail"])


def test_upload_without_message_ok(monkeypatch, fake_model):
    """正向：message 可省略，纯附件提交要能发出去，记录里只有文件名。"""
    resp = _upload("only.txt", "只有文件".encode("utf-8"), "", monkeypatch, fake_model)
    assert resp.status_code == 200
    assert "data: [DONE]" in resp.text
    cid = int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))
    user_text = client.get(f"/api/v1/conversations/{cid}/messages").json()[0]["content"]
    assert user_text.startswith("[上传文件] only.txt")
    assert "只有文件" in user_text


def test_corrupt_pdf_rejected():
    """错误路径：损坏 pdf 解析失败 400 中文，无 500 堆栈。"""
    resp = _upload("broken.pdf", b"%PDF-1.4\nnot really a pdf")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "文件解析失败，请确认文件未损坏且格式正确"


def test_spool_upload_reads_in_fixed_chunks(tmp_path):
    """暂存必须按固定块长读：一次 read() 拿全量等于又回到「整包进内存」。"""

    class _Recorder(io.BytesIO):
        def __init__(self, data):
            super().__init__(data)
            self.reads = []

        def read(self, size=-1):
            self.reads.append(size)
            return super().read(size)

    payload = b"a" * (files.UPLOAD_CHUNK_BYTES * 3 + 17)
    upload = type("FakeUpload", (), {"file": _Recorder(payload)})()
    path, size = files.spool_upload(upload, tmp_path)

    assert size == len(payload)
    assert path.read_bytes() == payload
    assert upload.file.reads, "至少要读过一次"
    assert all(item == files.UPLOAD_CHUNK_BYTES for item in upload.file.reads), upload.file.reads
    assert len(upload.file.reads) >= 4, "三次满块 + 一次残块 + 一次 EOF"


def test_spool_upload_oversize_leaves_no_partial_file(tmp_path, monkeypatch):
    """超限要在写入过程中就中断，并把半截临时文件删掉（否则就是一批无主文件）。"""
    monkeypatch.setattr(files, "MAX_UPLOAD_BYTES", 100)
    upload = type("FakeUpload", (), {"file": io.BytesIO(b"a" * 500)})()

    with pytest.raises(files.FileBizError):
        files.spool_upload(upload, tmp_path)

    assert list(tmp_path.iterdir()) == [], "超限后不许留下半截文件"


def test_large_upload_is_staged_and_tmp_cleaned(monkeypatch, caplog, fake_model):
    """大文件走分块暂存，结束后临时目录不残留任何文件。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    body = b"z" * (5 * 1024 * 1024)  # 5 MB：够跨几十个 256 KB 的块，又不必真造 10 MB

    with caplog.at_level(logging.INFO):
        resp = _upload("big.txt", body, "看看这个大文件")

    assert resp.status_code == 200
    assert "分块暂存" in caplog.text, "日志要能证明走了分块暂存这条路径"
    tmp_root = db_info.data_dir() / "tmp"
    left = [path for path in tmp_root.rglob("*") if path.is_file()] if tmp_root.exists() else []
    assert left == [], f"请求结束后临时文件必须清干净：{left}"


def test_cleanup_stale_spool_only_removes_old_dirs(tmp_path):
    """强杀留下的暂存目录要在下次启动被清掉，但正在上传的那份（新的）不能动。"""
    import os
    import time

    old = tmp_path / "chat-upload-old"
    (old / "sub").mkdir(parents=True)
    (old / "sub" / "a.txt").write_text("x", encoding="utf-8")
    stale = time.time() - 30 * 3600
    os.utime(old, (stale, stale))

    fresh = tmp_path / "chat-upload-fresh"
    fresh.mkdir()
    (fresh / "b.txt").write_text("y", encoding="utf-8")

    assert files.cleanup_stale_spool(tmp_path) == 1
    assert not old.exists()
    assert fresh.exists(), "还在 24 小时窗口内的目录不能删"
    assert files.cleanup_stale_spool(tmp_path / "nope") == 0


def test_long_text_truncated_with_notice(monkeypatch, fake_model):
    """超长文本：按 MAX_DOC_CHARS 截断并附中文说明。"""
    from core.files import MAX_DOC_CHARS

    resp = _upload(
        "long.txt",
        ("字" * (MAX_DOC_CHARS + 500)).encode("utf-8"),
        monkeypatch=monkeypatch,
        model=fake_model,
    )
    assert resp.status_code == 200
    cid = int(re.search(r'"conversation_id":\s*(\d+)', resp.text).group(1))
    user_text = client.get(f"/api/v1/conversations/{cid}/messages").json()[0]["content"]
    assert f"[文件过长，仅展示前 {MAX_DOC_CHARS} 字]" in user_text
    # 截断后整条消息不会膨胀太多（文件名 + 文本 + 说明 + 少量拼接）
    assert len(user_text) <= MAX_DOC_CHARS + 100
