"""对话组接口：模型列表 + 流式对话 + 文件上传对话。"""
import json
import logging
import queue
import tempfile
import threading
import time
from pathlib import Path

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core import ai, attachments, history
from core.chat import finish_delivery, open_exchange, stream_reply
from core.db_info import data_dir
from core.errors import BizError
from core.files import (
    MAX_TOTAL_BYTES,
    MAX_UPLOAD_FILES,
    MULTIPART_OVERHEAD,
    parse_upload,
    spool_upload,
)
from routers.common import raise_biz
from routers.deps import current_user_id
from schemas.chat import MAX_MODEL_NAME_LENGTH, ChatIn, normalize_message

logger = logging.getLogger(__name__)

router = APIRouter()

# SSE 必备响应头（否则前端拿到一次性输出）
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

# 流结束标记（协议固定，向后兼容）：消费侧要能识别它，才能在发出去之前先落库
DONE_FRAME = "data: [DONE]\n\n"


class VerifyIn(BaseModel):
    """验证请求：只接受模型注册表键（模型 id），长度与聊天接口的上限一致。"""

    id: str = Field(min_length=1, max_length=MAX_MODEL_NAME_LENGTH)

# 每发多少批探一次「客户端还在不在」：太小等于给每次发送都加一次 ASGI receive 往返
DISCONNECT_PROBE_EVERY = 16
# 队列里最多预取多少帧（一帧约 20 字）：模型吐得快时先攒着，消费侧一次合并发出去，
# 把「每帧一次线程往返」降成「每批一次」。上限也决定了取消时最多有多少帧还没发
STREAM_QUEUE_MAX = 16
# 一次唤醒最多合并多少帧：太大会让「边生成边显示」变成一段一段地蹦
STREAM_DRAIN_MAX = 16
# 等首字时的心跳间隔。上游模型超时是 60s，中间一个字节都没有时，
# 反向代理 / 浏览器空闲超时会先把连接掐掉，用户看到「转圈很久然后失败且没有回复」
STREAM_HEARTBEAT_SECONDS = 15.0
# 每次从队列取帧时最多占住一个 anyio 线程令牌多久。不能直接用 15 秒：
# 几十条流同时等首字就会把默认 40 个令牌占满，连心跳和取消都排不上队
STREAM_POLL_SECONDS = 1.0
# 停止时等生产者收尾（它负责 close 生成器并落库）的上限：模型已经不再产出，正常是毫秒级
STREAM_JOIN_SECONDS = 10.0
# 同时在跑的生产者线程上限：上游卡住（单次 60s 超时）时不能让线程数随请求线性增长。
# 拿不到名额最多等这么久：不设上限的话，超出上限的请求会各起一条线程永久挂在信号量上，
# 线程数仍随请求无界增长，只是从「同时跑 12 条」变成「排队排到失控」
STREAM_MAX_PRODUCERS = 12
STREAM_SLOT_WAIT_SECONDS = 5.0
_producer_slots = threading.BoundedSemaphore(STREAM_MAX_PRODUCERS)


def _sent_texts(frames: str) -> list[str]:
    """从即将发给客户端的 SSE 文本里取出正文片段，用于「只落库已发送内容」。"""
    texts: list[str] = []
    for block in frames.split("\n\n"):
        if not block.startswith("data: "):
            continue
        payload = block[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except ValueError:
            continue
        content = data.get("content") if isinstance(data, dict) else None
        if isinstance(content, str) and content:
            texts.append(content)
    return texts


def _produce(generator, items: "queue.Queue", cancel_event: threading.Event) -> None:
    """生产者线程：独占式迭代同步生成器，把帧塞进队列。

    关键点：生成器只能由这一个线程驱动。以前是异步侧每帧 run_sync 调一次 next()，
    取消时再跨线程 close()，会撞上「generator already executing」；现在 close 也在这里做，
    生成器的 finally（落库）因此一定有执行者。
    """
    if not _producer_slots.acquire(timeout=STREAM_SLOT_WAIT_SECONDS):
        # 名额耗尽时明确失败：消费侧拿到 error 帧能提示「繁忙」，比无限期挂着好
        try:
            items.put(("error", BizError("当前对话请求过多，请稍后再试", "too_many")), timeout=0.5)
        except queue.Full:
            pass
        try:
            generator.close()
        except Exception:  # noqa: BLE001
            logger.debug("关闭未能开始的生成器时出错（已忽略）", exc_info=True)
        return
    try:
        if cancel_event.is_set():
            return  # 排队期间用户已经点了停止：不必再跑一次模型
        try:
            for frame in generator:
                if cancel_event.is_set():
                    break
                while True:
                    try:
                        items.put(("chunk", frame), timeout=0.2)
                        break
                    except queue.Full:
                        # 消费侧已经停下（取消/断开）：别把队列当磁盘，直接收手
                        if cancel_event.is_set():
                            return
        except BaseException as exc:  # noqa: BLE001
            # 生成器内部异常要原样交给消费侧抛出：在那里抛才能让 ASGI 记到正确的请求上
            try:
                items.put(("error", exc), timeout=0.5)
            except queue.Full:
                pass
            return
        finally:
            try:
                generator.close()
            except Exception:  # noqa: BLE001
                logger.debug("关闭流式生成器时出错（已忽略）", exc_info=True)
            try:
                items.put(("done", None), timeout=0.5)
            except queue.Full:
                pass
    finally:
        _producer_slots.release()


def _take_batch(items: "queue.Queue"):
    """取一批帧；超过 STREAM_POLL_SECONDS 没有输出时返回 None（调用方决定是否发心跳）。"""
    try:
        first = items.get(timeout=STREAM_POLL_SECONDS)
    except queue.Empty:
        return None
    batch = [first]
    while len(batch) < STREAM_DRAIN_MAX:
        try:
            batch.append(items.get_nowait())
        except queue.Empty:
            break
    return batch


async def _iter_sync_stream(
    generator,
    request: Request,
    cancel_event: threading.Event,
    delivered: list[str],
    finish_state: dict,
):
    """把同步流式生成器包成可中断的异步迭代（生产者线程 + 队列 + 心跳）。

    为什么不再「每帧 run_sync 调 next()」：那样等首字期间没法往外发任何字节，
    而且取消时跨线程 close() 会抛「generator already executing」。
    现在生成器只归生产者线程所有，取消靠 cancel_event 协作，close 也在那个线程里做。

    落库口径：正文以 delivered 为准（消费侧在 yield 之后追加，即「真的发出去过」）。
    队列预取的帧若因停止而没发出去，不会进 delivered，也就不会出现在历史里。
    """
    items: "queue.Queue" = queue.Queue(maxsize=STREAM_QUEUE_MAX)
    producer = threading.Thread(
        target=_produce, args=(generator, items, cancel_event), name="sse-producer", daemon=True
    )
    producer.start()
    probe = 0
    last_emit = time.monotonic()
    finalized = False

    async def _finalize() -> None:
        """等生产者收尾 → 落库「已发送」的正文。只执行一次（正常路径在 [DONE] 之前调）。"""
        nonlocal finalized
        if finalized:
            return
        finalized = True
        with anyio.CancelScope(shield=True):
            try:
                await anyio.to_thread.run_sync(producer.join, STREAM_JOIN_SECONDS)
            except Exception:  # noqa: BLE001
                logger.debug("等待流式生产者退出时出错（已忽略）", exc_info=True)
            # 落库放在传输层而不是生成器里：队列里预取但没发出的帧不能算
            try:
                await anyio.to_thread.run_sync(finish_delivery, finish_state, "".join(delivered))
            except Exception:  # noqa: BLE001
                logger.exception("对话落库失败（传输层收尾）")

    try:
        while True:
            batch = await anyio.to_thread.run_sync(_take_batch, items)
            if batch is None:
                now = time.monotonic()
                if now - last_emit >= STREAM_HEARTBEAT_SECONDS:
                    last_emit = now
                    # 注释帧：SSE 解析器会忽略（没有 data: 行），只用来占住连接
                    yield ": ping\n\n"
                # 空转期间同样要探断开：只按「有正文的批」计数的话，
                # 模型久久不出字时用户关窗后要白跑十几分钟模型
                probe = (probe + 1) % DISCONNECT_PROBE_EVERY
                if probe == 0 and await request.is_disconnected():
                    break
                continue
            frames: list[str] = []
            finished = False
            for kind, payload in batch:
                if kind == "chunk":
                    frames.append(payload)
                elif kind == "error":
                    raise payload
                else:
                    finished = True
            if frames:
                merged = "".join(frames)
                # [DONE] 之前先把库写完：否则前端刚收到结束标记就切走/刷新，
                # 可能读到「还没有这条回答」的历史（落库被排到了响应之后）
                if DONE_FRAME in merged:
                    head, _, _ = merged.partition(DONE_FRAME)
                    if head:
                        yield head
                        # 只有 yield 返回（ASGI 真的发出去了）才算「已发送」
                        delivered.extend(_sent_texts(head))
                        last_emit = time.monotonic()
                    await _finalize()
                    yield DONE_FRAME
                    return
                yield merged
                delivered.extend(_sent_texts(merged))
                last_emit = time.monotonic()
            probe = (probe + 1) % DISCONNECT_PROBE_EVERY
            if probe == 0 and await request.is_disconnected():
                break
            if finished:
                return
    finally:
        # 先立旗让生成器自己收手；取消/异常路径也要落库（只落已发送的部分）
        cancel_event.set()
        await _finalize()


@router.get("/get_models")
def get_models():
    """列出可用模型与默认模型；无可用模型时返回中文提示而不是 500。"""
    return ai.get_models_payload()


# 验证接口的最小间隔（同一模型 id）：verify 会真的调一次上游并按量计费，
# 这是匿名可达的接口，不加间隔就等于把用户的额度开放给任何能连上本机端口的人
_VERIFY_MIN_INTERVAL_SECONDS = 3.0
# 节流记录条数上限：id 来自请求体且匿名可达，没有上限就是一条「发几个请求让进程内存涨上去」的路径。
# 与 core/user.py 的 _FAIL_TRACK_MAX 同一口径：满了两条策略，先清过期项，仍然满就拒绝新 id。
_VERIFY_TRACK_MAX = 10_000
# 时钟入口单独留名：单测要能替换它，否则「字典满 / 首条放行」这类用例的结果会取决于
# 机器已开机多久（monotonic 的绝对值是开机秒数），CI 新起 runner 与开发机表现不同
_verify_monotonic = time.monotonic
_verify_last: dict[str, float] = {}
_verify_lock = threading.Lock()


@router.post("/models/verify")
def verify_model(payload: VerifyIn):
    """验证某个模型的 Key / 模型 ID 是否可用（真实发一次极轻量请求）。

    由后端发而不是前端发：Key 只在后端进程里，交给页面等于泄露；
    返回只包含结论与中文原因，不含 Key，也不回传上游原文。
    """
    now = _verify_monotonic()
    with _verify_lock:
        # 用 None 而不是 0.0 表示「这个 id 还没验证过」：0.0 会让「开机不足 3 秒时的首次验证」
        # 被误判为过于频繁（now - 0.0 < 3.0），而那时后端本来就已经起来了
        last = _verify_last.get(payload.id)
        if last is not None and now - last < _VERIFY_MIN_INTERVAL_SECONDS:
            wait = int(_VERIFY_MIN_INTERVAL_SECONDS - (now - last)) + 1
            return {"ok": False, "error": f"验证过于频繁，请 {wait} 秒后再试"}
        if len(_verify_last) >= _VERIFY_TRACK_MAX and payload.id not in _verify_last:
            # 先清掉已过节的旧 id（它们再进来本来也要重新等 3 秒）；仍然满就拒绝，绝不让字典无界增长
            cutoff = now - _VERIFY_MIN_INTERVAL_SECONDS
            for stale in [key for key, stamp in _verify_last.items() if stamp <= cutoff]:
                _verify_last.pop(stale, None)
            if len(_verify_last) >= _VERIFY_TRACK_MAX:
                return {"ok": False, "error": "验证请求过于频繁，请稍后再试"}
        _verify_last[payload.id] = now
    return ai.verify_model(payload.id)


@router.post("/chat")
def chat(request: Request, payload: ChatIn, user_id: int | None = Depends(current_user_id)):
    """流式对话：SSE 逐段返回，会话与消息落库、会话落库后立刻发 conversation_id。"""
    # 传了别人的会话 id 一律 404：静默新建会让调用方以为在续聊，语义与其它接口不一致
    if payload.conversation_id is not None:
        try:
            history.ensure_owned(payload.conversation_id, user_id)
        except BizError as exc:
            raise_biz(exc)
    cancel_event = threading.Event()
    # 传输层记录「真正发出去」的正文：生成器收尾按它落库（队列预取的帧不算）
    delivered: list[str] = []
    finish_state: dict = {}
    # 落库在返回 StreamingResponse 之前完成：客户端若在首包前断开，生成器一次都不会被迭代，
    # 用户消息与附件行就丢了（前端乐观渲染的那条刷新即消失）
    exchange = open_exchange(
        payload.message,
        model_name=payload.model,
        conversation_id=payload.conversation_id,
        user_id=user_id,
        regenerate=payload.regenerate,
    )
    return StreamingResponse(
        _iter_sync_stream(
            stream_reply(
                payload.message,
                model_name=payload.model,
                conversation_id=payload.conversation_id,
                user_id=user_id,
                regenerate=payload.regenerate,
                cancel_event=cancel_event,
                delivered=delivered,
                finish_state=finish_state,
                exchange=exchange,
            ),
            request,
            cancel_event,
            delivered,
            finish_state,
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post("/chat_upload")
def chat_upload(
    request: Request,
    files: list[UploadFile] | None = File(None),
    file: UploadFile | None = File(None),
    message: str = Form(""),
    model: str | None = Form(None),
    conversation_id: int | None = Form(None),
    user_id: int | None = Depends(current_user_id),
):
    """带文件（可多个）的流式对话：图片多模态、文档抽文本；原文件落本机，消息挂附件元数据。

    files 是多附件字段，file 为旧客户端的单附件字段，两者都收（同时传则合并）。
    """
    # 0. 体积双保险：主要拦截在 main.py 的中间件（分发前就看 Content-Length，真正省掉收包与落盘）；
    #    这里再判一次是为了「中间件被摘掉 / 反向代理改写头」时不至于整包读进内存
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_TOTAL_BYTES + MULTIPART_OVERHEAD:
        raise HTTPException(
            status_code=413,
            detail=f"所有文件合计不能超过 {MAX_TOTAL_BYTES // (1024 * 1024)} MB",
        )
    # 1. 校验文字：message 在契约里是可选的，纯附件提交要放行；
    #    有文字就走与 /chat 同一套上限（Form 不走 Pydantic，不能漏）
    try:
        safe_message = normalize_message(message) if message.strip() else ""
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    # 2. 模型名只做个长度兜底，避免超长字符串进日志与错误文案
    if model and len(model) > MAX_MODEL_NAME_LENGTH:
        raise HTTPException(status_code=422, detail=f"模型名长度不能超过 {MAX_MODEL_NAME_LENGTH} 字")
    # 2b. 归属校验：与 /chat 同口径，别人的会话 id 直接 404
    if conversation_id is not None:
        try:
            history.ensure_owned(conversation_id, user_id)
        except BizError as exc:
            raise_biz(exc)
    # 3. 合并两组字段，校验数量；数量/体积问题在收包前尽量早退
    uploads = [item for item in (files or []) if item is not None]
    if file is not None:
        uploads.append(file)
    if not uploads:
        raise HTTPException(status_code=422, detail="请至少选择一个文件")
    if len(uploads) > MAX_UPLOAD_FILES:
        raise HTTPException(status_code=422, detail=f"一次最多上传 {MAX_UPLOAD_FILES} 个文件")
    # 4. 先全部暂存、全部解析，再统一落盘：
    #    边解析边落盘的话，第 N 个文件非法时前 N-1 个已经写进磁盘，而它们永远不会挂到消息上，
    #    成了没有归属的孤儿文件（清理逻辑只在启动时跑，用户看不到也删不掉）。
    #
    #    暂存到 DATA_DIR/tmp 下的一次性目录（与 UPLOAD_DIR 分开：这里的东西绝不进备份、
    #    也不会被孤儿清理逻辑当成附件）；分块写入 + 逐个文件读回解析，
    #    内存峰值从「全部文件 + 全部 base64」降到「最大单个文件 + 全部 base64 块」。
    file_blocks: list[dict] = []
    filenames: list[str] = []
    staged: list[tuple[Path, str, dict]] = []
    total_bytes = 0
    tmp_root = data_dir() / "tmp"
    try:
        tmp_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="chat-upload-", dir=tmp_root, ignore_cleanup_errors=True
        ) as tmp:
            for upload in uploads:
                # 统一走 safe_name：原始文件名会拼进 chat_messages.content，
                # 不做基名/控制字符/长度清洗就绕过了正文长度约定，也可能带上路径与控制字符
                name = attachments.safe_name(upload.filename)
                try:
                    # 峰值内存边界：最多同时持有「当前文件全文（解析用）+ 它的 base64/抽取正文」，
                    # 不是全部文件；落盘阶段走 save_upload_file 直接搬文件，不再多读一份
                    path, size = spool_upload(upload, Path(tmp))
                    total_bytes += size
                    if total_bytes > MAX_TOTAL_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"所有文件合计不能超过 {MAX_TOTAL_BYTES // (1024 * 1024)} MB",
                        )
                    # 解析器按字节工作（zip/pdf 库都要随机访问）：只把当前这个文件读回内存，
                    # 解析完立刻 del，别让它活到下一个文件
                    data = path.read_bytes()
                    try:
                        block = parse_upload(upload.filename, data)
                    finally:
                        del data
                except BizError as exc:
                    raise_biz(exc)
                file_blocks.append(block)
                filenames.append(name)
                staged.append((path, name, block))
            logger.info(
                "附件已分块暂存：%d 个文件、%d 字节（临时目录，请求结束即删）",
                len(staged),
                total_bytes,
            )

            # 5. 全部校验通过，才落本机（原文件 + 抽取正文）；单个失败只降级：
            #    本轮照样能聊，只是历史里点不开这个附件
            attachment_metas: list[dict] = []
            for path, name, block in staged:
                try:
                    # 直接搬暂存文件，不再 read_bytes：省掉「每请求多一份单文件大小」的峰值内存
                    attachment_metas.append(attachments.save_upload_file(path, name, block))
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "附件落盘失败，本轮对话继续（历史记录里看不到这个附件）", exc_info=True
                    )
    finally:
        # 上传体临时文件在这里统一显式关闭，不交给 GC 兜底
        for upload in uploads:
            try:
                upload.file.close()
            except Exception:  # noqa: BLE001
                logger.debug("关闭上传临时文件失败（已忽略）", exc_info=True)
    # 6. 走与 /chat 相同的流式管线，仅消息内容换成「文件块 + 问题」
    cancel_event = threading.Event()
    delivered: list[str] = []
    finish_state: dict = {}
    # 同上：附件与用户消息必须在响应开始前落库，否则首包前断开就是「消息+附件全丢」
    exchange = open_exchange(
        safe_message,
        model_name=model,
        conversation_id=conversation_id,
        user_id=user_id,
        file_blocks=file_blocks,
        filenames=filenames,
        attachment_metas=attachment_metas,
    )
    return StreamingResponse(
        _iter_sync_stream(
            stream_reply(
                safe_message,
                model_name=model,
                conversation_id=conversation_id,
                user_id=user_id,
                file_blocks=file_blocks,
                filenames=filenames,
                attachment_metas=attachment_metas,
                cancel_event=cancel_event,
                delivered=delivered,
                finish_state=finish_state,
                exchange=exchange,
            ),
            request,
            cancel_event,
            delivered,
            finish_state,
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
