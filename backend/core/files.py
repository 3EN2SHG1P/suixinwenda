"""上传文件解析：按后缀分派；上传体先分块落到临时文件，解析时才按单个文件读回内存。"""
import base64
import io
import logging
import os
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from core.errors import BizError

logger = logging.getLogger(__name__)

# 单文件字节上限（唯一源 =『MAX_UPLOAD_BYTES』；超限 413）
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# multipart 边界与头部额外开销（唯一源 =『MULTIPART_OVERHEAD』）：
# 预检 Content-Length 时放宽 1 MB，避免「刚好 10 MB 的正常文件」被误判 413
MULTIPART_OVERHEAD = 1024 * 1024
# 抽取文本送模型的字符上限（唯一源 =『MAX_DOC_CHARS』）
MAX_DOC_CHARS = 5000
# 解析时的防御性上限（唯一源 =『MAX_PDF_PAGES』/『MAX_SHEET_ROWS』）：
# 压缩炸弹（如 9 MB 的 xlsx 展开出千万行）在字符截断之前就会把 CPU 打满，必须在迭代中设闸
MAX_PDF_PAGES = 200
MAX_SHEET_ROWS = 5000
# 读上传体时的分块字节数（；防「先整读进内存再判大小」）
UPLOAD_CHUNK_BYTES = 256 * 1024
# 文件名长度上限（唯一源 =『MAX_FILENAME_LENGTH』）：入库名与聊天记录首行都用它，防超长串撑爆气泡
MAX_FILENAME_LENGTH = 120
# 一次最多几个附件 + 合计体积上限（单文件上限仍是 MAX_UPLOAD_BYTES）
MAX_UPLOAD_FILES = 9
MAX_TOTAL_BYTES = 30 * 1024 * 1024
# docx / xlsx 解压后的总字节上限（唯一源 =『MAX_UNZIPPED_BYTES』）：
# 上限卡的是「解压后」而不是上传字节数——9 MB 的 zip 做出 1000:1 压缩比很轻松，
# 而 docx.Document / load_workbook 在返回那一刻就把整包解压进内存，进程直接 OOM。
# 取 200 MB 而不是 60 MB：正常 docx 的 word/media/ 里图片解压后很容易超 60 MB，按 60 MB 会误杀正常文档
MAX_UNZIPPED_BYTES = 200 * 1024 * 1024

# 图片后缀 → mime（转 base64 走多模态）
_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
# 直接按 UTF-8 解码的文本类
_TEXT_EXTS = {".md", ".txt", ".csv", ".json"}
# 老格式：不支持（中文提示另存新格式）
_OLD_EXTS = {".doc", ".xls"}
# 全部支持后缀（错误提示里列清单用）
SUPPORTED_EXTS = sorted(set(_IMAGE_MIME) | _TEXT_EXTS | {".pdf", ".docx", ".xlsx", ".xlsm"})
# 文档后缀 → mime（附件的 Content-Type，下载 / 预览时用；不靠用户浏览器猜）
_DOC_MIME = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
}


class FileBizError(BizError):
    """文件业务异常：message 给用户看（中文），kind 映射 HTTP 状态码。

    kind 取值与状态码见 core.errors.KIND_STATUS：unsupported / parse_error → 400，too_large → 413。
    """


def _sniff_image(data: bytes) -> str | None:
    """按魔数判断真实图片格式，返回 mime；不是已知图片返回 None。

    只看后缀等于「把 exe/zip 改名 .png 就能通过校验」，一路以多模态载荷发给上游。
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    # WEBP 要读满 12 字节：RIFF + 4 字节长度 + WEBP 标记
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _check_zip_bomb(data: bytes) -> None:
    """docx / xlsx 解压前的闸：累加 zip 内声明的解压后大小，超上限直接 413。

    阈值必须在函数体内读模块常量（不写成参数默认值、也不在 import 期算好），
    否则测试无法用 monkeypatch 注入小阈值来覆盖这条分支。
    """
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        total = 0
        for info in archive.infolist():
            total += info.file_size
            if total > MAX_UNZIPPED_BYTES:
                raise FileBizError("文件解压后过大，请压缩内容后再上传", "too_large")


def _truncate(text: str) -> str:
    """超过 MAX_DOC_CHARS 截断并附中文说明。"""
    text = text.strip()
    if len(text) <= MAX_DOC_CHARS:
        return text
    return text[:MAX_DOC_CHARS] + f"\n[文件过长，仅展示前 {MAX_DOC_CHARS} 字]"


def _join_limited(chunks) -> str:
    """边迭代边累计字符数，达到 MAX_DOC_CHARS 立刻停止（不在内存里展开整份文档）。"""
    lines: list[str] = []
    total = 0
    for chunk in chunks:
        if not chunk:
            continue
        lines.append(chunk)
        total += len(chunk) + 1
        if total >= MAX_DOC_CHARS:
            break
    return _truncate("\n".join(lines))


def _pdf_text(data: bytes) -> str:
    """抽 PDF 文本：页数超上限即停，边抽边截断。"""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = reader.pages[:MAX_PDF_PAGES]
    return _join_limited(page.extract_text() or "" for page in pages)


def _docx_text(data: bytes) -> str:
    """抽 docx 正文段落文本，边抽边截断。"""
    import docx

    document = docx.Document(io.BytesIO(data))
    return _join_limited(p.text for p in document.paragraphs)


def _xlsx_text(data: bytes):
    """抽表格文本（生成器）：行数超上限立即停止产出，由 `_join_limited` 边收边截断。"""
    import openpyxl

    book = openpyxl.load_workbook(io.BytesIO(data), read_only=True)
    try:
        rows_seen = 0
        for sheet in book.worksheets:
            for row in sheet.iter_rows(values_only=True):
                rows_seen += 1
                if rows_seen > MAX_SHEET_ROWS:
                    logger.warning("表格行数超过上限 %s，已截断解析", MAX_SHEET_ROWS)
                    return
                cells = [str(c) for c in row if c is not None]
                if cells:
                    yield "\t".join(cells)
    finally:
        book.close()


def _extract_text(filename: str, ext: str, data: bytes) -> str:
    """按后缀抽取文本；解析异常一律 400 中文。"""
    try:
        if ext in _TEXT_EXTS:
            try:
                return _truncate(data.decode("utf-8"))
            except UnicodeDecodeError:
                raise FileBizError(
                    "文件编码不是 UTF-8，请另存为 UTF-8 后再上传", "parse_error"
                )
        if ext == ".pdf":
            return _pdf_text(data)
        if ext in (".docx", ".xlsx", ".xlsm"):
            # 解压前先过闸：解析器一被调用就会把整包解压进内存（解压后大小与上传字节数无关）
            _check_zip_bomb(data)
        if ext == ".docx":
            return _docx_text(data)
        if ext in (".xlsx", ".xlsm"):
            return _join_limited(_xlsx_text(data))
    except BizError:
        raise
    except Exception as exc:  # noqa: BLE001  损坏/加密/格式不符 → 400 中文
        logger.warning("解析文件失败 %s: %s", filename, exc)
        raise FileBizError("文件解析失败，请确认文件未损坏且格式正确", "parse_error")


def parse_upload(filename: str | None, data: bytes) -> dict:
    """解析上传文件，返回文件块：
    - 图片 → {"kind": "image", "mime", "b64"}（不入库，聊天记录只存文件名）
    - 文档 → {"kind": "text", "text": 抽取并截断的文本}
    两种都带 mime / ext / size，供附件表与下载接口复用（不再各处按后缀猜一遍）。
    """
    # 1. 无名文件按未知处理
    name = (filename or "").strip()
    if not name:
        raise FileBizError("缺少文件名", "unsupported")
    if len(name) > MAX_FILENAME_LENGTH:
        raise FileBizError(f"文件名太长（超过 {MAX_FILENAME_LENGTH} 字），请改名后再上传", "unsupported")
    # 2. 大小上限（正常路径已在路由层按块拦住，这里兜底）
    if len(data) > MAX_UPLOAD_BYTES:
        raise FileBizError(f"文件不能超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB", "too_large")
    # 3. 后缀分派
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in _OLD_EXTS:
        raise FileBizError(
            "暂不支持 .doc / .xls 老格式，请另存为 .docx / .xlsx 再上传", "unsupported"
        )
    if ext in _IMAGE_MIME:
        # 判定以内容为准：嗅探成功就用嗅探出的 mime（截图工具导出、jpg 改名 png 这类误命名不该被拦），
        # 嗅探失败说明内容根本不是图片（exe/zip 改名 .png），直接拒。
        # 注意：落盘后缀仍是原文件名后缀，可能与 mime 不一致，这是预期——不要在别处再由后缀反推 mime
        mime = _sniff_image(data)
        if mime is None:
            raise FileBizError("文件内容不是有效图片", "unsupported")
        return {
            "kind": "image",
            "mime": mime,
            "ext": ext,
            "size": len(data),
            "b64": base64.b64encode(data).decode("ascii"),
        }
    if ext in SUPPORTED_EXTS:
        return {
            "kind": "text",
            "mime": _DOC_MIME.get(ext, "text/plain"),
            "ext": ext,
            "size": len(data),
            "text": _extract_text(name, ext, data),
        }
    raise FileBizError(f"暂不支持该格式，支持：{'、'.join(SUPPORTED_EXTS)}", "unsupported")


def spool_upload(upload, directory: Path) -> tuple[Path, int]:
    """把上传体分块写进临时文件，返回 (路径, 字节数)。

    为什么不再 `b"".join(chunks)` 一次性拿全量：一次 9 个 10 MB 的附件，加上后续的
    base64 块，峰值会顶到 200 MB 以上；分块落盘后内存里最多只有一个文件的原始字节。

    超限在写入过程中就中断并删掉半截文件：不能等写完再判，那正是要避免的内存峰值。
    """
    directory.mkdir(parents=True, exist_ok=True)
    handle_fd, name = tempfile.mkstemp(prefix="upload-", dir=str(directory))
    target = Path(name)
    total = 0
    try:
        with os.fdopen(handle_fd, "wb") as handle:
            while True:
                chunk = upload.file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise FileBizError(
                        f"文件不能超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB", "too_large"
                    )
                handle.write(chunk)
    except BaseException:
        # 超限 / 读流出错都不留半截文件：它永远不会被挂到消息上，只会变成清理逻辑的负担
        target.unlink(missing_ok=True)
        raise
    return target, total


def cleanup_stale_spool(root: Path, max_age_seconds: int = 24 * 3600) -> int:
    """清掉上传暂存目录里「超龄」的一次性目录，返回删除个数。

    正常情况下 `TemporaryDirectory` 在请求结束时自己删；但进程被强杀 / 断电时它会留在
    `DATA_DIR/tmp` 下，一个 10 MB 的附件就是一份实打实的垃圾。只删除够旧的目录，
    避免把「正在上传」的那一份删掉。
    """
    if not root.exists():
        return 0
    deadline = time.time() - max_age_seconds
    removed = 0
    for child in root.iterdir():
        try:
            if not child.is_dir() or child.stat().st_mtime > deadline:
                continue
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
        except OSError:
            logger.debug("暂存目录清理失败：%s", child, exc_info=True)
    if removed:
        logger.info("已清理 %d 个残留的上传暂存目录", removed)
    return removed


def build_user_text(message: str, file_blocks: list[dict] | None, filenames: list[str] | None) -> str:
    """组装用户消息落库文本（文件本身不入库，只存 `[上传文件] 文件名` + 抽取文本 + 问题）。

    多附件时每个文件各占一段，顺序与用户选择顺序一致。
    """
    if not file_blocks:
        return message
    names = list(filenames or [])
    parts: list[str] = []
    for index, block in enumerate(file_blocks):
        name = names[index] if index < len(names) else "附件"
        parts.append(f"[上传文件] {name}")
        if block.get("kind") == "text" and block.get("text"):
            parts.append(block["text"])
    if message.strip():
        parts.append(message.strip())
    return "\n".join(parts)
