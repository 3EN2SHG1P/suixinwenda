"""模型上下文构建：只从数据库读 chat_messages + chat_summaries，产出 LangChain 消息对象。

口径（唯一）：
- 每轮 =「user + 其后的 active assistant」；被重新生成覆盖的旧回答（superseded=1）不参与；
- 保留窗口 = 最近 CONTEXT_ROUNDS 轮原文，更早的轮次由 chat_summaries 的一段摘要代表；
- 送模型的结构写死为 LangChain 消息对象，绝不返回裸 dict（直喂 model.stream() 会报错）。
"""
import logging
from types import SimpleNamespace

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from sqlmodel import Session, select

from core import attachments
from core.database import engine
from core.files import MAX_TOTAL_BYTES, MAX_UPLOAD_FILES
from models import ChatAttachment, ChatMessage

logger = logging.getLogger(__name__)

CONTEXT_ROUNDS = 10              # 送模型保留最近几轮完整问答；同时是摘要覆盖上界的唯一来源
SUMMARY_BATCH_ROUNDS = 5         # 保留窗口之外，每积累多少未覆盖轮才刷新一次摘要
CONTEXT_CHAR_BUDGET = 12000      # 上下文总字符上限（近似 token）
ATTACH_TEXT_LIMIT = 2000         # 单条附件正文进上下文的截断长度
IMAGE_ROUNDS = 5                 # 历史重放图片的窗口：含图片所在那一轮，共 5 轮（当前提问轮不计入）
IMAGE_MAX_COUNT = 6              # 历史图片重放张数上限（只改窗口不改张数等于没改，两者同时放宽）
IMAGE_MAX_BYTES = 4 * 1024 * 1024    # 历史图片单张上限
IMAGE_TOTAL_BYTES = 8 * 1024 * 1024  # 历史图片合计上限
SUMMARY_MAX_CHARS = 1200         # 摘要长度上限
# 摘要输入上限（旧摘要 + 新增对话的合计字符数）。只限输出不限输入时，积压几十轮后
# 「整段历史 + 旧摘要」会被原样拼进 prompt：上游按 token 计费，超长还会直接 400，
# 而这条路径在后台线程里失败，用户只会看到「摘要一直不刷新」。
SUMMARY_INPUT_MAX_CHARS = 8000
ROUND_CURSOR_MAX_ROWS = 20000    # round_cursor 读 (id, role) 的行数上限；达到上限就放弃本次摘要，不做近似

# 单次取多少条消息做上下文候选：先过滤 superseded 再 LIMIT，禁止全表 SELECT
CONTEXT_ROWS_LIMIT = 40

# 落库文本里附件段落的前缀（与 core/files.build_user_text 同源）
UPLOAD_MARK = "[上传文件]"

# 历史图片降级占位（P0 结论：图片重放可用，仅在超出窗口/上限/文件缺失时用它）
IMAGE_PLACEHOLDER = "[图片：{name}]"


def _id_of(item) -> int:
    """取消息 id：ORM 行走属性，`select(id, role)` 的 Row 两者都支持。"""
    return int(item.id if hasattr(item, "id") else item[0])


def _role_of(item) -> str:
    return str(item.role if hasattr(item, "role") else item[1])


def _pair_rounds(rows) -> tuple[list[tuple], object | None]:
    """把按 id 升序的消息配成轮：返回 (完整轮列表, 末尾未配对的 user 或 None)。

    只依赖每个元素的 .id 与 .role（不依赖 content），因此也可传 (id, role) 的 Row。
    规则（线性一遍）：
      - pending_user 为空时遇 user → pending_user = 该条
      - pending_user 非空时遇 user → 丢弃 pending_user（半轮），pending_user = 该条
      - pending_user 非空时遇 assistant → 成一轮 (pending_user, assistant)，清空 pending_user
      - pending_user 为空时遇 assistant → 孤立回答，丢弃
    末尾 pending_user 一律单独返回，调用方自行决定要不要用。
    """
    rounds: list[tuple] = []
    pending = None
    for row in rows:
        if _role_of(row) == "user":
            # 上一个提问没等到回答就被新提问顶掉：半轮直接丢弃，只留最新这条
            pending = row
        elif pending is not None:
            rounds.append((pending, row))
            pending = None
    return rounds, pending


def round_cursor(
    conversation_id: int, covered_message_id: int = 0, covered_rounds: int = 0
) -> tuple[int, int]:
    """返回 (rounds, upto_message_id)。

    rounds = 「配对成功」的轮数（含已进摘要的部分）；不能用 COUNT(user) 代替——
             中间有被停止的提问时会多算，导致 covered_rounds 前进过头。
    upto   = 完整轮列表里倒数第 CONTEXT_ROUNDS 轮的 user 消息 id（开区间上界）；
             完整轮不足 CONTEXT_ROUNDS 时返回 0。

    只读 `id >= covered_message_id` 的行：covered_message_id 是「第一条还没进摘要的
    提问」，它本身必须参与配对（它的回答在它后面）。已进摘要的区间不必再看，
    节流判断在稳定态下只碰最近十几轮（几十行）。传默认值时退化成全量读，与旧行为一致。
    仍然保留行数上限：达到上限就放弃本次——近似轮数会让两列永久错配。
    """
    with Session(engine) as session:
        rows = session.exec(
            select(ChatMessage.id, ChatMessage.role)
            .where(
                ChatMessage.conversation_id == conversation_id,
                ChatMessage.superseded == 0,
                ChatMessage.id >= int(covered_message_id or 0),
            )
            .order_by(ChatMessage.id.asc())  # 直接升序：配对状态机要求按 id 递增
            .limit(ROUND_CURSOR_MAX_ROWS)
        ).all()
    if len(rows) >= ROUND_CURSOR_MAX_ROWS:
        logger.error(
            "round_cursor 行数达到上限 %d，本次跳过摘要（conversation_id=%s）",
            ROUND_CURSOR_MAX_ROWS,
            conversation_id,
        )
        return 0, 0
    rounds, _pending = _pair_rounds(rows)
    total = int(covered_rounds or 0) + len(rounds)
    if len(rounds) < CONTEXT_ROUNDS:
        # 最近窗口还没被新轮次填满：本次不需要新摘要，upto 无意义
        return total, 0
    upto = rounds[-CONTEXT_ROUNDS][0]  # 倒数第 CONTEXT_ROUNDS 轮的那条 user
    return total, _id_of(upto)


def should_summarize(rounds: int, covered_rounds: int) -> bool:
    """节流唯一式子：pending = rounds - CONTEXT_ROUNDS - covered_rounds，够一批才刷新。

    covered_rounds = 0 时它等价于「rounds >= 15」，但这个推导不写成独立常量、也不写成独立条件。
    """
    pending = rounds - CONTEXT_ROUNDS - covered_rounds
    return pending >= SUMMARY_BATCH_ROUNDS


def plan_refresh(conversation_id: int) -> tuple[bool, int, int]:
    """一次取值决定要不要刷摘要：返回 (是否排任务, upto_message_id, cover_rounds_after)。

    调用方拿到后直接传给 summary.refresh：refresh 内部禁止再调 round_cursor()——
    两次取值之间进来一条新提问，covered_rounds 与 covered_message_id 就会错配。
    """
    from core.summary import summary_row  # 延迟导入：摘要模块反向依赖本模块的阈值常量

    # 先取摘要进度再数轮数：round_cursor 只需要看「已覆盖区间之后」的行
    _summary, covered_message_id, covered_rounds = summary_row(conversation_id)
    rounds, upto = round_cursor(conversation_id, covered_message_id, covered_rounds)
    cover_rounds_after = max(0, rounds - CONTEXT_ROUNDS)
    if upto <= 0 or not should_summarize(rounds, covered_rounds):
        return False, upto, cover_rounds_after
    # 覆盖区间内至少要有 1 条 active 消息：空区间排了也只会被 refresh 直接返回
    with Session(engine) as session:
        found = session.exec(
            select(ChatMessage.id)
            .where(
                ChatMessage.conversation_id == conversation_id,
                ChatMessage.superseded == 0,
                ChatMessage.id > covered_message_id,
                ChatMessage.id < upto,
            )
            .limit(1)
        ).first()
    return found is not None, upto, cover_rounds_after


def _strip_upload_markers(content: str) -> str:
    """剥掉开头连续的 `[上传文件] xxx` 行：老数据没有 question 列时用它兜底正文。"""
    lines = str(content or "").split("\n")
    index = 0
    while index < len(lines) and lines[index].startswith(UPLOAD_MARK):
        index += 1
    return "\n".join(lines[index:]).strip()


def _fetch_context_data(conversation_id: int):
    """一次取出候选消息与它们的附件（附件批量 IN，按 message_id 分桶）。"""
    with Session(engine) as session:
        rows = session.exec(
            select(ChatMessage)
            .where(
                ChatMessage.conversation_id == conversation_id,
                ChatMessage.superseded == 0,  # 先过滤：作废回答不进上下文
            )
            .order_by(ChatMessage.id.desc())
            .limit(CONTEXT_ROWS_LIMIT)
        ).all()
        rows = list(reversed(rows))  # 反转成升序再配对
        message_ids = [int(row.id) for row in rows if row.id is not None]
        grouped: dict[int, list[ChatAttachment]] = {}
        if message_ids:
            # 不能用 attachments.by_message_ids()：它返回前端 payload，没有 stored_path，喂不了 rebuild_block
            attachment_rows = session.exec(
                select(ChatAttachment)
                .where(ChatAttachment.message_id.in_(message_ids))
                .order_by(ChatAttachment.id.asc())
            ).all()
            for row in attachment_rows:
                grouped.setdefault(int(row.message_id), []).append(row)
    return rows, grouped


def _drop_current_reply(rows):
    """重新生成：剔除「最后一条 user 之后的第一条 assistant」，让本轮提问变回未配对。

    不能简单删「最后一条 assistant」：上一轮被停止过时，最后一条 assistant 属于更早轮次。
    """
    last_user_index = None
    for index in range(len(rows) - 1, -1, -1):
        if _role_of(rows[index]) == "user":
            last_user_index = index
            break
    if last_user_index is None:
        return rows
    for index in range(last_user_index + 1, len(rows)):
        if _role_of(rows[index]) == "assistant":
            return rows[:index] + rows[index + 1 :]
    return rows


def _image_meta(row, replayed: bool) -> dict:
    """图片的附件元数据：给「对话历史」弹窗显示缩略图，同时标明模型这轮是否真的重放了它。"""
    return {"id": int(row.id or 0), "name": row.name or "附件", "replayed": replayed}


def _placeholder(row) -> dict:
    """历史图片不重放时降级成文字占位（元数据仍保留：弹窗要能看出这条消息带过图）。"""
    return {
        "kind": "text",
        "text": IMAGE_PLACEHOLDER.format(name=row.name or "附件"),
        "image": _image_meta(row, False),
    }


def _history_items(rows: list, budget: dict, replay: bool) -> list[dict]:
    """历史轮次附件：最近 IMAGE_ROUNDS 轮内的图片重放，受三重上限约束，超限降级为文字占位。"""
    items: list[dict] = []
    for row in rows:
        if row.kind == "image":
            if not replay:
                items.append(_placeholder(row))
                continue
            # use_cache=True：历史重放每轮都会走这里，同一张图不该每轮重新读盘 + 重新 base64
            block = attachments.rebuild_block(row, use_cache=True)
            if block is None or not block.get("b64"):
                items.append(_placeholder(row))
                continue
            size = int(block.get("size") or 0)
            if (
                budget["count"] >= IMAGE_MAX_COUNT
                or size > IMAGE_MAX_BYTES
                or budget["bytes"] + size > IMAGE_TOTAL_BYTES
            ):
                items.append(_placeholder(row))
                continue
            budget["count"] += 1
            budget["bytes"] += size
            items.append(
                {
                    "kind": "image",
                    "mime": str(block.get("mime") or row.mime),
                    "b64": block["b64"],
                    "image": _image_meta(row, True),
                }
            )
        else:
            text = str(row.text_excerpt or "")[:ATTACH_TEXT_LIMIT]
            if text:
                items.append({"kind": "text", "text": text})
    return items


def _current_items(blocks: list[dict] | None, rows: list) -> list[dict]:
    """本轮提问的附件：不受 IMAGE_* 约束，按上传上限全量带。

    优先用调用方内存里的 blocks（避免重复读盘）；为空（如 regenerate）时按行 rebuild_block 重建。
    """
    items: list[dict] = []
    if blocks:
        for block in blocks[:MAX_UPLOAD_FILES]:
            if block.get("kind") == "image" and block.get("b64"):
                items.append(
                    {
                        "kind": "image",
                        "mime": str(block.get("mime") or "image/png"),
                        "b64": str(block["b64"]),
                    }
                )
            elif block.get("kind") == "text" and block.get("text"):
                items.append({"kind": "text", "text": str(block["text"])[:ATTACH_TEXT_LIMIT]})
        if items:
            return items
    total_bytes = 0
    for row in rows[:MAX_UPLOAD_FILES]:
        # regenerate 走这里：附件内容只能从磁盘重建，但仍可命中 (sha256, mtime) 缓存。
        # 缓存键已含 mtime，文件被替换必然失效，所以「本轮刚上传必须读盘」的理由不成立，
        # 用缓存能省掉每张图重复的读盘 + base64（9 张 10MB 图约 120MB 的临时峰值）
        block = attachments.rebuild_block(row, use_cache=True)
        if block is None:
            if row.kind == "image":
                items.append(_placeholder(row))
            continue
        if block.get("kind") == "image":
            size = int(block.get("size") or 0)
            if total_bytes + size > MAX_TOTAL_BYTES:
                items.append(_placeholder(row))
                continue
            total_bytes += size
            items.append(
                {
                    "kind": "image",
                    "mime": str(block.get("mime") or row.mime),
                    "b64": block["b64"],
                    "image": _image_meta(row, True),
                }
            )
        else:
            text = str(block.get("text") or "")[:ATTACH_TEXT_LIMIT]
            if text:
                items.append({"kind": "text", "text": text})
    return items


def _compose_content(items: list[dict], question: str) -> str | list:
    """附件块 + question 组合成消息内容：纯文本给 str，含图片给多模态数组。"""
    texts = [item["text"] for item in items if item["kind"] == "text"]
    images = [item for item in items if item["kind"] == "image"]
    if question:
        texts.append(question)
    if not images:
        return "\n\n".join(text for text in texts if text)
    # 多模态结构写死：text 段 + 每张图一个 image_url 段（shape 错了会 400 或静默丢图）
    content: list[dict] = [
        {"type": "text", "text": "\n\n".join(text for text in texts if text) or "请描述这张图片的内容"}
    ]
    for image in images:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image['mime']};base64,{image['b64']}"},
            }
        )
    return content


def _user_message(row, items: list[dict]) -> tuple[HumanMessage, list[dict]]:
    """把一条 user 消息还原成 (HumanMessage, 该消息的图片元数据)。

    内容四种组合（别重复）：
      有块 + 有 question → 块 + question；
      有块 + 无 question → 只放块（块里已含抽取正文，不拿 content 兜底）；
      无块 + 有 question → 只放 question；
      无块 + 无 question → 用 content 剥掉开头 `[上传文件]` 行后的正文兜底。
    图片元数据只用于「对话历史」弹窗显示缩略图，不参与送模型的内容。
    """
    question = str(getattr(row, "question", "") or "").strip()
    images = [item["image"] for item in items if item.get("image")]
    if not items:
        return HumanMessage(content=question or _strip_upload_markers(row.content)), images
    if not question and all(item["kind"] == "image" for item in items):
        # 老数据（question 为 NULL）且附件全是图片：图片块本身没有正文，把你当时打的字补回来；
        # 文档块里有抽取正文，这种情况不走这条，避免同一段正文塞两遍
        question = _strip_upload_markers(row.content)
    return HumanMessage(content=_compose_content(items, question)), images


def _char_len(message: BaseMessage) -> int:
    """近似字符数：只数文本段（图片由 IMAGE_* 三重上限控制，不按 base64 长度算）。"""
    content = getattr(message, "content", "")
    if isinstance(content, list):
        return sum(
            len(str(part.get("text") or "")) for part in content if isinstance(part, dict)
        )
    return len(str(content or ""))


def _total_len(
    head: list[BaseMessage], history_messages: list[BaseMessage], tail: BaseMessage
) -> int:
    """当前候选内容的总字符数（含摘要与最后一条提问）。"""
    total = sum(_char_len(message) for message in head)
    total += sum(_char_len(message) for message in history_messages)
    return total + _char_len(tail)


def _fallback_context(
    current_blocks: list[dict] | None, current_message: str
) -> list[BaseMessage]:
    """查库失败时的独立早返回：只用本轮内容拼一条消息（不让用户看到「生成失败」）。"""
    if current_blocks:
        items = _current_items(current_blocks, [])
        return [HumanMessage(content=_compose_content(items, current_message))]
    if current_message:
        return [HumanMessage(content=current_message)]
    logger.error("上下文无法构建：查库失败且没有本轮内容可退")
    raise RuntimeError("上下文不可用")


def _build_context(
    conversation_id: int,
    *,
    current_blocks: list[dict] | None = None,
    current_message: str = "",
    regenerate: bool = False,
) -> tuple[list[BaseMessage], list[list[dict]]]:
    """构建上下文：返回 (消息列表, 每条消息对应的图片元数据)，两者下标一一对应。"""
    caller = SimpleNamespace(question=current_message, content="")
    try:
        rows, attachment_rows = _fetch_context_data(conversation_id)
    except Exception:  # noqa: BLE001
        # 查库抖动不能变成「生成失败」：降级链是独立早返回，不允许正常建完再补一条
        logger.warning(
            "读取上下文失败，降级用本轮内容拼消息（conversation_id=%s）",
            conversation_id,
            exc_info=True,
        )
        fallback = _fallback_context(current_blocks, current_message)
        return fallback, [[] for _ in fallback]

    if regenerate:
        rows = _drop_current_reply(rows)

    rounds, pending = _pair_rounds(rows)
    # ① 按轮丢最旧：更早的轮次由摘要代表
    rounds = rounds[-CONTEXT_ROUNDS:]

    from core.summary import summary_for  # 延迟导入：摘要模块反向依赖本模块的阈值常量

    summary_text = summary_for(conversation_id) if conversation_id else ""

    # 历史图片预算：从最新一轮往前分配，避免「老图吃掉配额、最近的图反而变占位」
    budget = {"count": 0, "bytes": 0}
    round_items: list[list[dict]] = [[] for _ in rounds]
    for index in range(len(rounds) - 1, -1, -1):
        user_row = rounds[index][0]
        replay = (len(rounds) - index) <= IMAGE_ROUNDS
        round_items[index] = _history_items(
            attachment_rows.get(_id_of(user_row), []), budget, replay
        )

    # 每轮两条消息（user + assistant）：图片元数据只挂在 user 上
    history_messages: list[BaseMessage] = []
    history_images: list[list[dict]] = []
    rounds_in_context = 0
    for index, (user_row, ai_row) in enumerate(rounds):
        user_message, images = _user_message(user_row, round_items[index])
        history_messages.append(user_message)
        history_images.append(images)
        history_messages.append(AIMessage(content=str(ai_row.content or "")))
        history_images.append([])
        rounds_in_context += 1

    pending_items = _current_items(
        current_blocks,
        attachment_rows.get(_id_of(pending), []) if pending is not None else [],
    )
    pending_message, pending_images = _user_message(
        pending if pending is not None else caller, pending_items
    )

    # ③ 摘要截断
    head: list[BaseMessage] = []
    head_images: list[list[dict]] = []
    if summary_text:
        head.append(SystemMessage(content=f"（更早对话摘要）{summary_text[:SUMMARY_MAX_CHARS]}"))
        head_images.append([])

    # ④ 字符预算兜底：丢最旧轮次，本轮提问永远保留。
    #    总量只在进入循环时算一次，之后每丢一轮减掉这两条的长度：
    #    在循环里反复 _total_len 等于每丢一轮就把剩下的全部消息重新遍历一遍（O(n²)）
    total_len = _total_len(head, history_messages, pending_message)
    while rounds_in_context and total_len > CONTEXT_CHAR_BUDGET:
        total_len -= _char_len(history_messages[0]) + _char_len(history_messages[1])
        history_messages = history_messages[2:]
        history_images = history_images[2:]
        rounds_in_context -= 1

    messages: list[BaseMessage] = list(head) + history_messages
    images: list[list[dict]] = list(head_images) + history_images

    # 本轮提问只从 DB 重建（start_exchange 在生成前已落库）：
    # 只有「DB 里没有未配对 user」时才用调用方文案兜底，绝不重复追加同一句提问
    if pending is not None or not any(isinstance(message, HumanMessage) for message in messages):
        messages.append(pending_message)
        images.append(pending_images)
    return messages, images


def load_context(
    conversation_id: int,
    *,
    current_blocks: list[dict] | None = None,
    current_message: str = "",
    regenerate: bool = False,
) -> list[BaseMessage]:
    """构建本轮送模型的 messages：摘要 + 最近几轮原文 + 本轮提问。

    regenerate=True 时本轮回答还没落库/正要作废，先把「最后一条 user 之后的 assistant」剔掉，
    于是本轮提问变回未配对的 pending user，更早轮次不受影响（上一轮被停止过也不会丢一轮）。
    """
    messages, _images = _build_context(
        conversation_id,
        current_blocks=current_blocks,
        current_message=current_message,
        regenerate=regenerate,
    )
    return messages


def load_context_view(conversation_id: int) -> list[dict]:
    """「对话历史」弹窗用：上下文消息 + 每条消息带来的图片元数据（与模型实际看到的一致）。"""
    messages, images = _build_context(conversation_id)
    return [
        {"message": message, "images": images[index] if index < len(images) else []}
        for index, message in enumerate(messages)
    ]
