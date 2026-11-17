"""流式对话：会话与消息落库 + 从数据库构建上下文 + 把模型输出逐段转成 SSE 载荷。"""
import json
import logging
import queue
import threading
import time

from core import ai, context, files, history, summary
from core.errors import BizError

logger = logging.getLogger(__name__)

# 对外固定的生成失败文案：原始异常只进服务端日志，绝不回传给用户。
# 指向「设置 → 模型」而不是 .env：桌面端把模型配置写在 userData 的 models.json 里，
# 打包态连后端配置文件都是 userData/config.env，让用户去翻 backend/.env 根本找不到。
STREAM_ERROR_TEXT = "生成失败，请稍后重试；若持续失败请到「设置 → 模型」检查模型与 API Key"
# 无可用模型时的中文提示
NO_MODEL_TEXT = "暂无可用模型，请在「设置 → 模型」里添加模型并填写 API Key"

# 流式攒帧（唯一源）：模型每 chunk 可能只有一两个字，逐字发一帧 SSE 会让
# 渲染层每字一次 DOM 更新。攒够字符数或时间其一即发；首帧永远立刻发（用户要看到「出了字」）。
STREAM_FLUSH_CHARS = 20
STREAM_FLUSH_SECONDS = 0.04


def _sse(payload: dict) -> str:
    """组装一条 SSE 消息：data: {json}\\n\\n，中文不转义。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _content_text(content) -> str:
    """把 chunk.content 归一成纯文本：多模态 list 只拼 text 段。"""
    if isinstance(content, list):
        return "".join(
            str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in content
        )
    return str(content or "")


def _model_stream(model, messages):
    """直连模型逐段产出文本：上下文已由 core.context.load_context 从数据库构建。"""
    for chunk in model.stream(messages):
        text = _content_text(getattr(chunk, "content", ""))
        if text:
            yield text


def _pump(stream, conversation_id: int | None, cancel_event, reply_parts: list[str], began_at: float):
    """攒帧产出 SSE 文本；每段前检查取消，落库只写已经发出去的片段。

    攒帧规则见 STREAM_FLUSH_CHARS / STREAM_FLUSH_SECONDS：
    - 首帧立即发（否则用户要等模型攒够 20 字才看到第一个字）；
    - 客户端取消时不 flush 缓冲：那部分从未发出去，按「只落库已发送内容」的口径必须丢弃。
    """
    buffer: list[str] = []
    buffered = 0
    last_flush = began_at
    first = True
    cancelled = False
    try:
        for text in stream:
            # 客户端已停止：只保留停止前真正发出去的内容，别再白跑模型
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                logger.info(
                    "客户端已停止，生成提前结束（conversation_id=%s，已产出 %d 字）",
                    conversation_id,
                    sum(len(part) for part in reply_parts),
                )
                break
            if first:
                logger.info(
                    "首字耗时 %.2fs（conversation_id=%s）",
                    time.monotonic() - began_at,
                    conversation_id,
                )
            buffer.append(text)
            buffered += len(text)
            now = time.monotonic()
            if first or buffered >= STREAM_FLUSH_CHARS or now - last_flush >= STREAM_FLUSH_SECONDS:
                chunk = "".join(buffer)
                buffer.clear()
                reply_parts.append(chunk)
                buffered = 0
                last_flush = now
                first = False
                yield _sse({"content": chunk})
        # 正常结束：把最后不足一帧的尾巴发出去（取消路径不进这里）
        if not cancelled and buffer:
            chunk = "".join(buffer)
            reply_parts.append(chunk)
            yield _sse({"content": chunk})
    finally:
        logger.info(
            "生成结束：用时 %.2fs，共 %d 字（conversation_id=%s）",
            time.monotonic() - began_at,
            sum(len(part) for part in reply_parts),
            conversation_id,
        )
        close_stream = getattr(stream, "close", None)
        if close_stream is not None:
            try:
                close_stream()
            except Exception:  # noqa: BLE001
                logger.debug("关闭模型流失败（已忽略）", exc_info=True)


# 摘要刷新队列（唯一入口）：小消费线程池 + 去重集合。
# 不用 ThreadPoolExecutor：CPython 退出时会对 worker 执行 join，正在跑的慢摘要照样拖住退出。
# 两条线程而不是一条：摘要要调上游模型（单次超时 60s），一条线程时某个会话的慢请求
# 会把其它会话的摘要全堵在队列里，表现为「聊了很多但摘要一直不更新」。
SUMMARY_WORKERS = 2
# 队列上限：正常只会有一小批会话在排，堆到 200 说明上游长期不可用，
# 这时候继续排队只会让内容越来越旧——直接丢弃并由下一轮重新触发
SUMMARY_QUEUE_MAX = 200
_queue: "queue.Queue[int]" = queue.Queue(maxsize=SUMMARY_QUEUE_MAX)
# 已在排队/正在执行的会话 id（队列里只放 int，模型对象现取，避免挂死旧引用）
_pending: set[int] = set()
_lock = threading.Lock()
_workers: list[threading.Thread] = []
# 关服信号：worker 用它退出阻塞的 get()，否则进程退出时正在跑的摘要会被硬切
_stop = threading.Event()


def _ensure_worker() -> None:
    """首次入队时才起线程；import 期绝不起线程（否则任何 core.chat 导入都会凭空多一条线程）。"""
    with _lock:
        _workers[:] = [worker for worker in _workers if worker.is_alive()]
        while len(_workers) < SUMMARY_WORKERS and not _stop.is_set():
            worker = threading.Thread(
                target=_worker_loop, name=f"summary-worker-{len(_workers) + 1}", daemon=True
            )
            worker.start()
            _workers.append(worker)


def _run_summary_task(conversation_id: int) -> None:
    """执行一个摘要任务：模型不可用直接跳过，异常只记日志，绝不让 worker 线程死掉。

    这条 daemon 线程是整个进程唯一的摘要入口：一次未捕获异常它就直接退出，
    之后所有会话的摘要永久停摆，而日志里只有一条 traceback，基本不会有人注意到。
    """
    try:
        model = ai.get_model()  # 现取：模型注册表可能被换过，队列里不放模型对象
        if model is None:
            logger.info("摘要任务跳过：当前没有可用模型（conversation_id=%s）", conversation_id)
            return
        summary.refresh_latest(conversation_id, model)
    except Exception:  # noqa: BLE001
        logger.exception("摘要后台任务失败（已忽略，conversation_id=%s）", conversation_id)
    finally:
        # 只在任务真正跑完（成功/失败/跳过）时移除：执行期间来的新一轮会被丢弃、下一轮再入队，
        # 避免同一会话连着跑两次模型
        with _lock:
            _pending.discard(conversation_id)


def _worker_loop() -> None:
    """消费队列的一条线程；收到关服信号就退出（daemon，join 有超时）。"""
    while not _stop.is_set():
        try:
            conversation_id = _queue.get(timeout=1.0)
        except queue.Empty:
            continue
        _run_summary_task(conversation_id)


def stop_summary_worker(timeout: float = 2.0) -> None:
    """关服时停掉所有摘要线程：`--reload`/正常退出不该把正在写的摘要直接截断。

    timeout 是整个停止过程的预算：逐个 join 会按线程数翻倍等待。
    """
    _stop.set()
    with _lock:
        workers = list(_workers)
    deadline = time.monotonic() + timeout
    for worker in workers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if worker.is_alive():
            worker.join(remaining)


def _schedule_summary(conversation_id: int | None, model, cancel_event) -> None:
    """回答结束后把摘要刷新排进队列；用户点了停止就不排（半截回答不进摘要）。

    这里只入队、不查库：节流判断（plan_refresh）挪到 worker 里做，
    避免把一次 DB 往返塞回「用户已经看到完整回答」之后的收尾路径。
    """
    # 这两个 None 判断是现有行为，必须保留：模型不可用的回合仍会走到这里，
    # 放进来只会让 worker 白跑一趟并刷日志
    if conversation_id is None or model is None:
        return
    if cancel_event is not None and cancel_event.is_set():
        return
    _ensure_worker()  # ① 先起线程（它内部自己 with _lock）
    with _lock:  # ② 再取锁判重：顺序反了会死锁（Lock 不可重入）
        if conversation_id in _pending:
            return
        _pending.add(conversation_id)
    logger.debug("摘要任务入队（conversation_id=%s）", conversation_id)
    try:
        _queue.put_nowait(conversation_id)  # ③ 入队；队列里只放 int，绝不阻塞聊天收尾
    except queue.Full:
        # 队列满 = 上游长期不可用，继续排队只会让摘要内容越来越旧；清掉去重标记，下一轮再试
        with _lock:
            _pending.discard(conversation_id)
        logger.info("摘要队列已满，跳过本次刷新（conversation_id=%s）", conversation_id)


def _persist_exchange(
    *,
    started: bool,
    conv_id: int | None,
    text: str,
    user_id: int | None,
    regenerate: bool,
    model_name: str | None,
    model,
    cancel_event,
) -> None:
    """落库本轮回复 + 排摘要。失败只记日志：绝不能吞掉调用方的 error / [DONE] 收尾。"""
    if not started or conv_id is None:
        return
    try:
        history.finish_exchange(
            conv_id,
            text,
            user_id,
            supersede=regenerate,
            # 记录注册表里实际会用的键，而不是 .env 回退模式的常量
            model_name=ai.resolve_model_name(model_name),
        )
    except Exception:  # noqa: BLE001
        logger.exception("对话落库失败（conversation_id=%s）", conv_id)
    # 摘要刷新放在回答结束之后，后台跑：晚一轮生效可接受，绝不拖慢首字
    try:
        _schedule_summary(conv_id, model, cancel_event)
    except Exception:  # noqa: BLE001
        logger.exception("排摘要刷新失败（已忽略，conversation_id=%s）", conv_id)


def finish_delivery(state: dict | None, text: str) -> None:
    """传输层在流结束后调用：落库「真正发出去」的正文。

    队列预取但没发出的帧不在 text 里，因此用户点停止后，历史里不会多出没看到的字。
    """
    if not state:
        return
    _persist_exchange(
        started=bool(state.get("started")),
        conv_id=state.get("conv_id"),
        text=text,
        user_id=state.get("user_id"),
        regenerate=bool(state.get("regenerate")),
        model_name=state.get("model_name"),
        model=state.get("model"),
        cancel_event=state.get("cancel_event"),
    )


def _resolve_error(model_name: str | None) -> str | None:
    """先判断模型可用性：不可用就返回中文错误，避免先建出一个永远没有回复的僵尸会话。

    非白名单模型名统一回 400 的固定文案，不回显用户输入（防把超长/恶意字符串塞进 error 气泡）。
    """
    if model_name and not ai.model_exists(model_name):
        return NO_MODEL_TEXT
    if ai.get_model(model_name) is None:
        return NO_MODEL_TEXT
    return None


def open_exchange(
    message: str,
    *,
    model_name: str | None = None,
    conversation_id: int | None = None,
    user_id: int | None = None,
    file_blocks: list[dict] | None = None,
    filenames: list[str] | None = None,
    attachment_metas: list[dict] | None = None,
    regenerate: bool = False,
) -> dict:
    """把「本轮提问落库 + 模型可用性判断」在路由线程里同步做完。

    为什么不让生成器去做：StreamingResponse 只有在开始迭代时才会执行生成器体。
    客户端在首包前断开（或响应被中间件提前取消）时，生成器一次都没跑，
    用户消息与附件行就不落库——前端已经乐观渲染了那条消息，刷新即消失。
    路由是同步函数（跑在线程池里），在这里落库不会阻塞事件循环。

    返回 {conv_id, started, error, record_text}，供 stream_reply 直接使用。
    """
    record_text = files.build_user_text(message, file_blocks, filenames)
    conv_id = conversation_id
    # 只有本轮真的落过库才在收尾时回写：start_exchange 抛异常时 conv_id 仍是传入值，
    # 不加这个标记就会拿别人的会话 id 去刷新 update_time
    started = False
    error = _resolve_error(model_name)
    if regenerate:
        # 重新生成绝不新增消息（模型不可用时也一样）：以前这里会落进「已有会话」分支，
        # 等于每点一次重新生成就多插一条一模一样的 user 消息
        if conversation_id is None:
            conv_id = None
            error = "会话不存在，无法重新生成"
        else:
            try:
                history.ensure_owned(conversation_id, user_id)
            except BizError:
                conv_id = None
                error = "会话不存在，无法重新生成"
            else:
                conv_id = conversation_id
                # 只有模型可用才标记「本轮已落库」：started 决定收尾要不要写 assistant，
                # 模型不可用时写进去只会覆盖掉原回答
                started = error is None
    elif error is None:
        conv_id = history.start_exchange(
            conversation_id, record_text, user_id, attachment_metas, question=message
        )
        started = True
    elif conversation_id is not None:
        try:
            history.ensure_owned(conversation_id, user_id)
        except BizError:
            # 不属于自己/不存在：既不落库也不回传该 id（否则等于把别人的会话 id 还给调用方）
            conv_id = None
        else:
            conv_id = history.start_exchange(
                conversation_id, record_text, user_id, attachment_metas, question=message
            )
            started = True
    return {"conv_id": conv_id, "started": started, "error": error, "record_text": record_text}


def stream_reply(
    message: str,
    *,
    model_name: str | None = None,
    conversation_id: int | None = None,
    user_id: int | None = None,
    file_blocks: list[dict] | None = None,
    filenames: list[str] | None = None,
    attachment_metas: list[dict] | None = None,
    regenerate: bool = False,
    cancel_event=None,
    delivered: list[str] | None = None,
    finish_state: dict | None = None,
    exchange: dict | None = None,
):
    """逐段产出 SSE 文本；先落库会话与用户消息，会话一建好就发 conversation_id，出错发 error 不断流。

    file_blocks 非空 = 文件上传对话（可多个）：落库存 `[上传文件]` 文本，送模型用抽取文本/多模态结构；
    attachment_metas 非空 = 这些附件的落盘元数据，与用户消息同一事务入库（历史里才点得开）；
    regenerate=True = 重新生成：不新增消息，覆盖最后一条 assistant，上下文由数据库重建（含上一问的附件）；
    cancel_event（threading.Event）= 客户端已停止：每产出一段前检查，置位就立刻收手，
    本次只落库「停止前已经发给用户的内容」，不会事后补出一条完整回答。
    delivered（list[str]）= 由传输层在「真的发出去之后」追加的正文片段。路由改成
    生产者线程 + 队列预取之后，reply_parts 会包含已产出但还没发送的帧；收尾以 delivered
    为准，才能保证「停止后不多出没看到的字」。不传时退化为 reply_parts（直连调用与单测）。
    finish_state（dict）= 与 delivered 配套：生成器只把落库需要的信息写进去，
    由传输层在流彻底结束后调用 finish_delivery 落库（那时才知道最后一帧发没发出去）。
    exchange（dict）= 路由已经调过 open_exchange 的结果：此时本函数不再碰数据库去建会话，
    避免出现「生成器没被迭代 → 用户消息丢落库」。
    """
    reply_parts: list[str] = []
    # 1. 落库与模型判断：优先用路由传来的结果（生成器可能根本没被迭代）；
    #    直连调用（单测/工具）时自己算一份，行为与以前一致
    state = (
        exchange
        if exchange is not None
        else open_exchange(
            message,
            model_name=model_name,
            conversation_id=conversation_id,
            user_id=user_id,
            file_blocks=file_blocks,
            filenames=filenames,
            attachment_metas=attachment_metas,
            regenerate=regenerate,
        )
    )
    conv_id = state["conv_id"]
    started = bool(state["started"])
    error: str | None = state["error"]
    sent_conversation = False
    model = None
    began_at = time.monotonic()
    try:
        # 2b. 尽早把「待落库状态」交给传输层：收尾可能因为上游卡住、join 超时而拿不到
        #     生成器 finally 里补写的那份；提前写好，至少能保证已发送内容一定落库
        if finish_state is not None:
            finish_state.update(
                {
                    "started": started,
                    "conv_id": conv_id,
                    "user_id": user_id,
                    "regenerate": regenerate,
                    "model_name": model_name,
                    "model": model,
                    "cancel_event": cancel_event,
                }
            )
        # 3. 会话一落库就把 id 发出去：左侧列表能立刻置顶/出现，不用等模型答完
        if conv_id is not None:
            sent_conversation = True
            yield _sse({"conversation_id": conv_id})
        # 4. 流式生成：任何异常都转成 error 载荷（响应头已发出，改不了状态码）
        if error is None:
            model = ai.get_model(model_name)
            # 尽早把真实模型写进待落库状态：上游卡住导致 finally 没跑完时，传输层收尾
            # 只能读到这里的值；漏了它就会把回答记成「默认模型」，并跳过摘要刷新
            if finish_state is not None:
                finish_state["model"] = model
            # 上下文只来自数据库：本轮提问已在 start_exchange 落库，不再追加 current_message
            messages = context.load_context(
                conv_id,
                current_blocks=file_blocks if not regenerate else [],
                current_message=message,
                regenerate=regenerate,
            )
            yield from _pump(
                _model_stream(model, messages), conv_id, cancel_event, reply_parts, began_at
            )
    except GeneratorExit:
        # 4b. 客户端断开（关窗/点停止）：不再往外抛，收尾照常落库
        logger.info("流式生成被客户端中断（conversation_id=%s）", conv_id)
        raise
    except Exception:  # noqa: BLE001
        logger.exception("流式生成失败")
        error = STREAM_ERROR_TEXT
    finally:
        # 5. 无论正常结束、异常还是用户点「停止」中断，都只落库已产出的那部分回复；
        #    一个字都没出来就不写 assistant，避免「停止后切回来凭空多出一条回答」。
        #    落库失败只记日志，绝不能吞掉下面的 error / [DONE] 收尾。
        #
        #    delivered 非空 = 由传输层负责收尾：生成器在这里只交接待落库的状态，
        #    落库由 finish_delivery 在「客户端真的收完」之后做。原因是生成器的 finally
        #    在最后一帧还排在队列里、可能根本没发出去时就执行了，早落库会多出用户没看到的字。
        if delivered is None:
            _persist_exchange(
                started=started,
                conv_id=conv_id,
                text="".join(reply_parts),
                user_id=user_id,
                regenerate=regenerate,
                model_name=model_name,
                model=model,
                cancel_event=cancel_event,
            )
        elif finish_state is not None:
            finish_state.update(
                {
                    "started": started,
                    "conv_id": conv_id,
                    "user_id": user_id,
                    "regenerate": regenerate,
                    "model_name": model_name,
                    "model": model,
                    "cancel_event": cancel_event,
                }
            )
    # 6. error 载荷（如有）
    if error:
        yield _sse({"error": error})
    # 7. conversation_id 兜底（正常路径已在落库后立刻发过）→ 结束标记必须最后且无条件发出
    if conv_id is not None and not sent_conversation:
        yield _sse({"conversation_id": conv_id})
    yield "data: [DONE]\n\n"
