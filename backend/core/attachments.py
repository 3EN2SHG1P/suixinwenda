"""附件持久化：原文件落本机 `data/uploads`，元数据进 `chat_attachments`。

口径：
- 二进制只在本机磁盘，不参与模型调用（模型只用 `core.files.parse_upload` 的产物），也不上传第三方；
- 同一文件按 sha256 去重落盘，多条消息可共用一份；
- `stored_path` 只存相对路径，绝不把后端绝对路径写进数据库或回给前端。
"""
import base64
import hashlib
import logging
import os
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path

from sqlmodel import Session, select

from core.database import engine
from core import db_info
from core.db_info import data_dir
from core.errors import BizError
from core.limits import clip
from models import ChatAttachment

logger = logging.getLogger(__name__)

# 入库长度上限（与 models/attachment.py 的 max_length 对齐）
MAX_NAME_LENGTH = 255
MIME_MAX = 120
STORED_PATH_MAX = 255
# 文本被截断的标记（与 core.files._truncate 的中文说明同源）
TRUNCATE_MARK = "仅展示前"

# 历史重放缓存：同一张图在窗口内会被每一轮重新读盘并重新 base64 编码，
# 而这段在「首字」之前的同步路径上，图越大首字延迟越明显。
# key 用 (sha256, mtime_ns)：内容相同但文件被替换时 mtime 会变，自然失效，不需要额外的失效接口。
# 容量 16 = core.context.IMAGE_MAX_COUNT(6) 的两倍多：一次上下文构建要重放 6 张图，
# 再切一次会话就会把上一批全挤掉，8 张时命中率只有一半，未命中就要重新读盘 + base64。
# 32MB 的 b64 预算对应「最多 16 张大图」的常驻内存上限：每 1 字节原文件在 b64 里约占 1.37 字节，
# 即最坏情况下这块 LRU 常驻约 32MB——本机桌面应用可接受，换来的是首字延迟不再被磁盘拖累。
_HISTORY_CACHE: "OrderedDict[tuple[str, int], dict]" = OrderedDict()
_HISTORY_CACHE_MAX_ITEMS = 16
_HISTORY_CACHE_MAX_CHARS = 32 * 1024 * 1024
_HISTORY_CACHE_LOCK = threading.Lock()


def _history_cache_get(key: tuple[str, int]) -> dict | None:
    with _HISTORY_CACHE_LOCK:
        block = _HISTORY_CACHE.get(key)
        if block is None:
            return None
        _HISTORY_CACHE.move_to_end(key)
        return block


def _history_cache_put(key: tuple[str, int], block: dict) -> None:
    with _HISTORY_CACHE_LOCK:
        _HISTORY_CACHE[key] = block
        _HISTORY_CACHE.move_to_end(key)
        while _HISTORY_CACHE and (
            len(_HISTORY_CACHE) > _HISTORY_CACHE_MAX_ITEMS
            or sum(len(item["b64"]) for item in _HISTORY_CACHE.values()) > _HISTORY_CACHE_MAX_CHARS
        ):
            _HISTORY_CACHE.popitem(last=False)


def legacy_upload_root() -> Path:
    """旧版平铺结构的位置（不含后端名）。

    两个来源都在函数内求值：模块级常量会在 import 时固定，
    测试的 monkeypatch 与打包后的 DATA_DIR 都不会生效，而且全程不报错。
    """
    override = os.environ.get("UPLOAD_DIR")
    return Path(override) if override else data_dir() / "uploads"


def upload_dir() -> Path:
    """当前库专属的附件根：`<UPLOAD_DIR 或 data/uploads>/<storage_scope()>`。

    为什么按「库身份」而不是只按后端分目录：cleanup_orphans 用「当前库的引用全集」
    当白名单，切到另一个空库时该集合为空，会把不属于本库的文件全判成孤儿删掉。
    只按 sqlite / mysql 分还不够——本地 MySQL 与远程 MySQL 是两个库，共用
    `uploads/mysql` 时同样会互相误删。scope 里带 host/port/name，两个库各管一半。
    """
    return legacy_upload_root() / db_info.storage_scope()


def _move_referenced(source_root: Path, target_root: Path, wanted: set[str], keep_source: bool) -> dict:
    """把 source_root 下「当前库引用到的」文件搬到 target_root。

    keep_source=True 时用复制而不是移动：上一版按后端名分目录，同一后端名下可能
    躺着另一个库（本地/远程 MySQL）的附件，移动会把它偷走。复制最坏只是多占一份磁盘。
    """
    result = {"moved": 0, "skipped": 0, "failed": 0}
    if source_root == target_root or not source_root.exists():
        return result
    for rel in sorted(wanted):
        source = source_root / rel
        if not source.is_file():
            continue
        target = target_root / rel
        if target.exists():
            result["skipped"] += 1
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if keep_source:
                shutil.copy2(str(source), str(target))
            else:
                shutil.move(str(source), str(target))
            result["moved"] += 1
        except OSError:
            result["failed"] += 1
            logger.warning("附件迁移失败：%s → %s", source, target, exc_info=True)
    return result


def migrate_legacy_uploads() -> dict:
    """把旧结构的附件搬进当前库的目录，幂等：
    1. 平铺的 `uploads/<xx>/<sha>`（更老的版本）→ 移动；
    2. `uploads/<backend>/<xx>/<sha>`（上一版）→ 复制，见 _move_referenced 的说明。

    只搬「当前库引用到的那些」：切到空库时集合为空，一个文件都不动，
    另一个库的附件原地保留；等切回那个库时再按它的引用集搬，所以不会出现
    「切一次就把另一个库的附件挪到自己名下」。
    """
    target_root = upload_dir()
    legacy_root = legacy_upload_root()
    result = {"moved": 0, "skipped": 0, "failed": 0}
    if target_root == legacy_root:
        return result

    with Session(engine) as session:
        # 只取一列：整行 ORM 对象会把 text_excerpt（可能几十 KB/条）一起读进内存
        wanted = set(session.exec(select(ChatAttachment.stored_path)).all())
    if not wanted:
        return result

    sources = (
        (legacy_root, False),
        (legacy_root / db_info.db_backend(), True),
    )
    for source_root, keep_source in sources:
        part = _move_referenced(source_root, target_root, wanted, keep_source)
        for key in result:
            result[key] += part[key]

    if result["moved"]:
        _prune_empty_dirs(legacy_root)
        logger.info(
            "附件目录已按库分开：搬入 %d 个，跳过 %d 个，失败 %d 个",
            result["moved"],
            result["skipped"],
            result["failed"],
        )
    return result


def _prune_empty_dirs(root: Path) -> None:
    """删掉旧结构留下的空目录：只删空的，任何还有文件的目录都不碰。"""
    if not root.exists():
        return
    for child in sorted(root.iterdir(), key=lambda item: item.name):
        if not child.is_dir():
            continue
        try:
            if not any(child.iterdir()):
                child.rmdir()
        except OSError:
            logger.debug("旧附件空目录删除失败：%s", child, exc_info=True)


def safe_name(filename: str | None) -> str:
    """只留基名、去掉控制字符并截断；空名给「未命名文件」。"""
    base = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    base = "".join(ch for ch in base if ch.isprintable())[:MAX_NAME_LENGTH].strip()
    return base or "未命名文件"


def _ext_of(name: str) -> str:
    return "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""


def write_atomic(target: Path, data: bytes) -> None:
    """写临时文件再原子替换：绝不让「写了一半」的文件以最终名出现在磁盘上。

    直接 write_bytes 中途被杀会留下截断文件，而 exists() 从此为真——
    同 sha 之后的每次上传都不会重写，rebuild_block 读到的永远是半张图。
    临时名带 pid + 线程 id：同 sha 并发上传时两个请求各写各的 tmp，不会互相踩。

    公开给 tools/restore.py 复用：恢复附件与上传附件必须同一套落盘语义，
    复制一遍迟早会有一边漏掉 os.replace。
    """
    tmp = target.with_name(f"{target.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, target)
    finally:
        # 成功路径里 tmp 已被 replace 走，这里只剩失败遗留；best-effort 删掉不遮挡原始异常
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            logger.debug("清理附件临时文件失败：%s", tmp, exc_info=True)


def save_upload(data: bytes, filename: str | None, file_block: dict) -> dict:
    """落盘原文件，返回可入库的元数据（不写库，由会话落库时同事务插入）。"""
    name = safe_name(filename)
    digest = hashlib.sha256(data).hexdigest()
    rel = f"{digest[:2]}/{digest}{_ext_of(name)}"
    target = upload_dir() / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    # 1. 同 sha 已有文件就不重复写（重复上传同一张图很常见）；新写一律走原子替换
    if not target.exists():
        write_atomic(target, data)
    return _meta_of(name, digest, rel, len(data), file_block)


def _sha256_file(path: Path) -> str:
    """流式计算文件摘要：附件可能 10MB，read_bytes 只为算 sha 会白白多一份峰值。"""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _move_into_place(source: Path, target: Path) -> None:
    """把暂存文件搬到最终位置；跨卷时退回「复制到临时名 + 原子替换」。
    两条路径都不允许让写了一半的文件以最终名出现（同 write_atomic 的理由）。"""
    try:
        os.replace(source, target)
        return
    except OSError:
        logger.debug("直接移动附件失败，退回复制：%s", source, exc_info=True)
    tmp = target.with_name(f"{target.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    try:
        with source.open("rb") as src, tmp.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            logger.debug("清理附件临时文件失败：%s", tmp, exc_info=True)


def save_upload_file(
    source: Path, filename: str | None, file_block: dict, size: int | None = None
) -> dict:
    """落盘一个已经暂存在磁盘上的附件（上传接口用），语义与 save_upload 完全一致。

    为什么不复用 save_upload(bytes)：上传接口为了解析（zip/pdf 需要随机访问）已经把文件
    写进了 tmp，再 read_bytes 一次等于每请求多一份「单个文件大小」的内存峰值（上限 10MB）。
    这里改成流式算 sha + 移动文件，峰值只剩读缓冲区。
    """
    name = safe_name(filename)
    byte_size = int(size if size is not None else source.stat().st_size)
    digest = _sha256_file(source)
    rel = f"{digest[:2]}/{digest}{_ext_of(name)}"
    target = upload_dir() / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        _move_into_place(source, target)
    return _meta_of(name, digest, rel, byte_size, file_block)


def _meta_of(name: str, digest: str, rel: str, size: int, file_block: dict) -> dict:
    """两种落盘方式共用的入库元数据：保证字段口径只有一处。"""
    # 抽取正文与送模型的文本同源：前端「查看内容」直接读，不再二次解析
    text = str(file_block.get("text") or "")
    return {
        "name": clip(name, MAX_NAME_LENGTH),
        # mime 来自请求体，理论上可以是任意长度：SQLite 不拦，MySQL 会 1406
        "mime": clip(str(file_block.get("mime") or "application/octet-stream"), MIME_MAX),
        "size": int(size),
        "kind": "image" if file_block.get("kind") == "image" else "text",
        "sha256": digest,
        "stored_path": clip(rel, STORED_PATH_MAX),
        "text_excerpt": text,
        "truncated": 1 if TRUNCATE_MARK in text else 0,
    }


# 下载/预览时允许原样回给浏览器的 mime 白名单。
# 库里这一列来自请求体或历史备份包，若原样回 text/html / image/svg+xml，
# 在本机 API 源（带 JWT 与完整会话）上打开等于执行脚本；白名单外一律按二进制下载
SAFE_DOWNLOAD_MIME = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
    }
)


def safe_download_mime(mime: str | None) -> str:
    """把库里的 mime 收敛到白名单；带 charset 等参数的一律按主类型判断。"""
    value = str(mime or "").split(";", 1)[0].strip().lower()
    return value if value in SAFE_DOWNLOAD_MIME else "application/octet-stream"


def attach_to_message(
    session: Session, message_id: int, conversation_id: int, meta: dict, now: int | None = None
) -> ChatAttachment:
    """在当前事务里给一条消息挂附件（commit 由调用方负责）。"""
    row = ChatAttachment(
        message_id=message_id,
        conversation_id=conversation_id,
        name=meta["name"],
        mime=meta["mime"],
        size=int(meta.get("size") or 0),
        kind=meta["kind"],
        sha256=meta["sha256"],
        stored_path=meta["stored_path"],
        text_excerpt=str(meta.get("text_excerpt") or ""),
        truncated=int(meta.get("truncated") or 0),
        add_time=int(now or time.time()),
    )
    session.add(row)
    return row


def to_payload(row: ChatAttachment) -> dict:
    """对外描述：前端据此渲染卡片 / 灯箱 / 预览；不含磁盘路径。"""
    return {
        "id": row.id,
        "name": row.name,
        "mime": row.mime,
        "size": row.size,
        "kind": row.kind,
        "truncated": bool(row.truncated),
    }


def by_message_ids(session: Session, message_ids: list[int]) -> dict[int, list[dict]]:
    """批量取附件（一条 SQL），避免逐条消息再查一次。"""
    if not message_ids:
        return {}
    rows = session.exec(
        select(ChatAttachment)
        .where(ChatAttachment.message_id.in_(message_ids))
        .order_by(ChatAttachment.id.asc())
    ).all()
    grouped: dict[int, list[dict]] = {}
    for row in rows:
        grouped.setdefault(int(row.message_id), []).append(to_payload(row))
    return grouped


def get_row(attachment_id: int) -> ChatAttachment:
    """取附件元数据；不存在按 404 中文。"""
    with Session(engine) as session:
        row = session.get(ChatAttachment, attachment_id)
        if row is None:
            raise BizError("附件不存在或已被清理", "not_found")
        return row


def resolve_path(row: ChatAttachment) -> Path:
    """相对路径 → 本机绝对路径；越界（`..` / 绝对路径）直接拒绝。"""
    root = upload_dir().resolve()
    target = (root / row.stored_path).resolve()
    if target != root and root not in target.parents:
        raise BizError("附件路径不合法", "not_found")
    return target


def rebuild_block(row: ChatAttachment, use_cache: bool = False) -> dict | None:
    """把落盘附件还原成「送模型的 file_block」：图片回读原文件，文档用落库的抽取正文。

    重新生成时用它复用原附件——否则模型拿不到图，只能凭记忆里的描述作答。
    use_cache 只给「历史重放」用：本轮刚上传的文件必须读盘，避免拿到缓存里的旧内容。
    返回的 dict 可能来自缓存，调用方只读，不要就地修改。
    """
    if row.kind == "image":
        path = resolve_path(row)
        if not path.exists():
            return None
        key: tuple[str, int] | None = None
        if use_cache:
            try:
                key = (row.sha256, path.stat().st_mtime_ns)
            except OSError:
                key = None  # 取不到 mtime 就退化成直接读盘，不因此报错
            if key is not None:
                cached = _history_cache_get(key)
                if cached is not None:
                    return cached
        data = path.read_bytes()
        block = {
            "kind": "image",
            "mime": row.mime,
            "size": len(data),
            "b64": base64.b64encode(data).decode("ascii"),
        }
        if key is not None:
            _history_cache_put(key, block)
        return block
    text = str(row.text_excerpt or "")
    if not text:
        return None
    return {"kind": "text", "mime": row.mime, "text": text, "size": row.size}


def delete_by_conversation(session: Session, conversation_id: int) -> list[Path]:
    """随会话删附件记录，返回「提交后可以删的物理文件」。

    文件删除交给调用方在 commit 之后做：先 unlink 后 commit 的话，一旦 commit 失败
    就会出现「记录还在、文件已经没了」的反向孤儿。
    """
    rows = session.exec(
        select(ChatAttachment).where(ChatAttachment.conversation_id == conversation_id)
    ).all()
    digests = {row.sha256 for row in rows}
    for row in rows:
        session.delete(row)
    if not digests:
        return []
    session.flush()
    # 仍有别的记录引用的哈希保留文件（同 sha 可能被多条消息共用）：
    # 一次 IN 查询取回「还活着的 sha 集合」，而不是对每个 sha 各查一次
    still_used = set(
        session.exec(
            select(ChatAttachment.sha256).where(ChatAttachment.sha256.in_(digests))
        ).all()
    )
    orphans: list[Path] = []
    for sha in digests - still_used:
        # 两种形态都要匹配：带后缀的 `sha.ext` 与无后缀的 `sha`。
        # 只写 `sha.*` 会漏掉「文件名里没有点」（如 `README`、中文名无扩展名）落盘的那份，
        # 表现为删完会话后磁盘上还留着一个永远删不掉的孤儿（只能等 7 天后的兜底清理）
        pattern = f"{sha[:2]}/{sha}"
        orphans.extend(upload_dir().glob(f"{pattern}.*"))
        bare = upload_dir() / pattern
        if bare.is_file():
            orphans.append(bare)
    return orphans


def remove_files(paths: list[Path]) -> None:
    """事务提交后删物理文件：失败只记日志，不影响已经成功的删除结果。"""
    for path in paths:
        try:
            path.unlink()
        except OSError:
            logger.debug("删除附件文件失败（不阻断会话删除）：%s", path, exc_info=True)


def cleanup_orphans(max_age_seconds: int = 7 * 86400) -> int:
    """清掉「数据库里没有任何引用、且落盘超过 7 天」的文件。

    写盘成功但入库失败（进程被杀 / 数据库断连）会留下这类孤儿；
    保留 7 天是为了不误删正在上传途中的文件。返回删除个数。
    """
    root = upload_dir()
    if not root.exists():
        return 0
    try:
        with Session(engine) as session:
            known = set(session.exec(select(ChatAttachment.stored_path)).all())
    except Exception:  # noqa: BLE001
        logger.exception("读取附件清单失败，跳过本次孤儿清理")
        return 0
    removed = 0
    now = time.time()
    for path in root.glob("*/*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel in known:
            continue
        try:
            if now - path.stat().st_mtime < max_age_seconds:
                continue
            path.unlink()
            removed += 1
        except OSError:
            logger.debug("清理孤儿附件失败：%s", path, exc_info=True)
    if removed:
        logger.info("已清理 %s 个孤儿附件文件", removed)
    return removed
