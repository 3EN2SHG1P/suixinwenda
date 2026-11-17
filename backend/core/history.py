"""会话与聊天记录业务：标题生成、归属校验、列表/详情/删除、对话落库。

分层约定：本层只碰数据库，不写 HTTP；异常由 HistoryBizError 携带中文文案与分类，路由层映射状态码。
"""
import logging
import re
import time

from sqlalchemy import and_ as sa_and
from sqlalchemy import delete as sa_delete
from sqlalchemy import or_ as sa_or
from sqlalchemy import update as sa_update
from sqlmodel import Session, select

from core import attachments
from core.database import engine
from core.errors import BizError
from core.limits import clip
from models import ChatMessage, ChatSummary, Conversation

logger = logging.getLogger(__name__)

# 会话标题长度：取第一句话前 N 字（唯一源 =『会话标题长度』）
TITLE_MAX = 30
# 入库长度（与 conversations.title 的 max_length 对齐）：手动改名比自动标题长，模型层只保证 100
TITLE_MAX_STORED = 100

# 第一句话切分：遇到中英文句读或换行即止
_SENTENCE_SPLIT = re.compile(r"[。！？!?；;\n]")

# 空会话占位标题
EMPTY_TITLE = "新的对话"

# 认领匿名会话的两道闸（唯一源 =『认领限制』）：
# 单次 id 上限，避免一次塞几万个 id 当枚举器；时间窗，避免认领到与自己无关的陈年匿名会话
CLAIM_MAX_IDS = 50
CLAIM_WINDOW_SECONDS = 86_400

# 会话列表单页上限（唯一源 =『列表分页』）：默认 100，调用方最大可要 500。
# 不设上限时「一次要全部」等于没有分页；上限放到 500 是为了容得下「导出/迁移」这类合理的大批量读。
CONVERSATIONS_DEFAULT_LIMIT = 100
CONVERSATIONS_MAX_LIMIT = 500

# 会话内消息单页条数（唯一源 =『消息分页』）：默认 50，路由的 limit 校验取这里的上限。
# 几百轮的长会话一次全量返回几百条（含附件 payload），前端要连着建几百个 DOM 行，切换明显卡。
MESSAGES_DEFAULT_LIMIT = 50
MESSAGES_MAX_LIMIT = 200


class HistoryBizError(BizError):
    """会话业务异常：message 给用户看（中文），kind 由路由层统一映射状态码（默认 not_found）。"""

    def __init__(self, message: str, kind: str = "not_found"):
        super().__init__(message, kind)


def make_title(message: str) -> str:
    """取第一句话前 TITLE_MAX 字做会话标题；空则「新的对话」。"""
    # 1. 只取第一句话（到第一个句读或换行为止）
    first = _SENTENCE_SPLIT.split(message.strip(), maxsplit=1)[0].strip()
    # 2. 截断到上限；空消息兜底占位标题
    return first[:TITLE_MAX] or EMPTY_TITLE


def _owned(session: Session, conversation_id: int, user_id: int | None) -> Conversation | None:
    """归属校验：不是自己（或匿名串号）一律视为不存在。"""
    conv = session.get(Conversation, conversation_id)
    if conv is None:
        return None
    if user_id is None:
        return conv if conv.user_id is None else None
    return conv if conv.user_id == user_id else None


def _last_assistant(
    session: Session, conversation_id: int, superseded: int | None = None
) -> ChatMessage | None:
    """取该会话 id 最大的一条 assistant；superseded 传 0/1 可只看当前版/旧版。"""
    stmt = select(ChatMessage).where(
        ChatMessage.conversation_id == conversation_id,
        ChatMessage.role == "assistant",
    )
    if superseded is not None:
        stmt = stmt.where(ChatMessage.superseded == superseded)
    return session.exec(stmt.order_by(ChatMessage.id.desc())).first()


def _last_user_id(session: Session, conversation_id: int) -> int | None:
    """最后一条 user 消息的 id：重新生成时用它划定「本轮」范围。"""
    found = session.exec(
        select(ChatMessage.id)
        .where(ChatMessage.conversation_id == conversation_id, ChatMessage.role == "user")
        .order_by(ChatMessage.id.desc())
        .limit(1)
    ).first()
    return int(found) if found is not None else None


def _has_user_between(session: Session, conversation_id: int, low_id: int, high_id: int) -> bool:
    """两条消息之间是否夹着别的提问：夹着就说明它们不属于同一轮，不能互相覆盖。"""
    found = session.exec(
        select(ChatMessage.id)
        .where(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.role == "user",
            ChatMessage.id > low_id,
            ChatMessage.id < high_id,
        )
        .limit(1)
    ).first()
    return found is not None


def start_exchange(
    conversation_id: int | None,
    message: str,
    user_id: int | None,
    attachment_metas: list[dict] | None = None,
    question: str = "",
) -> int:
    """对话开始落库：定位或新建会话（归属不符必须新建）+ 存用户消息（+ 附件）+ 刷新 update_time。

    attachment_metas 是 core.attachments.save_upload 的产物列表：与消息同一事务插入，避免「消息在、附件丢」。
    question 是用户真正打的字（不含 `[上传文件]` 前缀与抽取正文）：重建上下文只认它；
    写失败或为空都不影响本轮（老数据的 question 为 NULL，运行时兜底到 content）。
    """
    now = int(time.time())
    with Session(engine) as session:
        # 1. 定位已有会话；未传 / 不属于当前用户 → 新建（不报错）
        conv = _owned(session, conversation_id, user_id) if conversation_id else None
        if conv is None:
            conv = Conversation(
                user_id=user_id,
                title=make_title(message),
                add_time=now,
                update_time=now,
            )
            session.add(conv)
            session.flush()  # 先拿到自增 id 再挂消息
        # 2. 存用户消息并刷新会话时间（flush 过的对象已在会话中，不必重复 add）
        conv.update_time = now
        row = ChatMessage(
            conversation_id=conv.id,
            role="user",
            content=message,
            question=(question or "").strip() or None,
            add_time=now,
        )
        session.add(row)
        session.flush()  # 先拿到消息 id 再挂附件
        for meta in attachment_metas or []:
            if meta:
                attachments.attach_to_message(session, int(row.id), int(conv.id), meta, now)
        session.commit()
        return int(conv.id)


def finish_exchange(
    conversation_id: int,
    reply: str,
    user_id: int | None,
    supersede: bool = False,
    model_name: str = "",
) -> None:
    """对话结束落库：assistant 回复非空才存，并刷新会话 update_time。

    supersede=True 是「重新生成」：只把**本轮**那条回答降级为旧版（内容保留，供「回退上一版」），
    新回答作为当前版；更早的旧版直接丢弃，每轮只有「当前 + 上一版」两份。
    归属校验：不是本人（含匿名串号）的会话一律不写，避免替别人刷新会话时间。
    """
    reply = reply.strip()
    now = int(time.time())
    with Session(engine) as session:
        conv = _owned(session, conversation_id, user_id)
        if conv is None:
            # 静默丢回复是「历史里少了回答」最难查的一种：至少要在日志里留个痕
            logger.warning(
                "落库跳过：会话不存在或不属于当前用户（conversation_id=%s）", conversation_id
            )
            return
        conv.update_time = now
        session.add(conv)
        # 1. 模型一个字都没答（报错等）不存空消息
        if reply:
            if supersede:
                # 1.1 本轮 = 最后一条 user 之后的那一段。之前只取「id 最大的 active assistant」，
                #     在「上一轮回答进行中又发了新提问」时会降级**下一轮**的回答，
                #     再把全会话旧版一起删掉，导致更早轮次的回退版本也没了。
                last_user_id = _last_user_id(session, conversation_id)
                current = _last_assistant(session, conversation_id, superseded=0)
                if current is not None and (
                    last_user_id is None or current.id < last_user_id
                ):
                    # 本轮还没有回答（active 的那条属于更早轮次）：没有可降级的对象
                    current = None
                # 1.2 更早轮次的旧版保留：只清本轮内的旧版，每轮留一步回退
                if last_user_id is not None:
                    session.exec(
                        sa_delete(ChatMessage).where(
                            ChatMessage.conversation_id == conversation_id,
                            ChatMessage.role == "assistant",
                            ChatMessage.superseded == 1,
                            ChatMessage.id > last_user_id,
                        )
                    )
                else:
                    session.exec(
                        sa_delete(ChatMessage).where(
                            ChatMessage.conversation_id == conversation_id,
                            ChatMessage.role == "assistant",
                            ChatMessage.superseded == 1,
                        )
                    )
                # 1.3 只降级本轮这一条（内容不动，回退时原样取回）
                if current is not None:
                    current.superseded = 1
                    session.add(current)
            session.add(
                ChatMessage(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=reply,
                    add_time=now,
                    model=(model_name or "")[:64],
                )
            )
        session.commit()


def revert_last_regenerate(conversation_id: int, user_id: int | None) -> dict:
    """回退一步：当前这一轮换回上一版（现版本降级为旧版，可再被下次重新生成挤掉）。

    只在「同一轮」内对调：两版之间夹着别的提问时一律拒绝，
    否则会把更早轮次的旧回答顶成当前回答，历史顺序就乱了。
    """
    with Session(engine) as session:
        conv = _owned(session, conversation_id, user_id)
        if conv is None:
            raise HistoryBizError("会话不存在")
        active = _last_assistant(session, conversation_id, superseded=0)
        previous = _last_assistant(session, conversation_id, superseded=1)
        if active is None or previous is None:
            raise HistoryBizError("没有可回退的版本", "invalid")
        if previous.id > active.id or _has_user_between(
            session, conversation_id, previous.id, active.id
        ):
            raise HistoryBizError("没有可回退的版本", "invalid")
        active.superseded = 1
        previous.superseded = 0
        session.add(active)
        session.add(previous)
        session.commit()
        return {"id": previous.id, "content": previous.content, "model": previous.model}


def repair_superseded_flags() -> int:
    """修历史数据（幂等）：把被整会话误降级的旧轮次恢复成正常显示，返回恢复条数。

    旧版「重新生成」按整会话把 assistant 全标成 superseded=1，历史里只剩最后一条。
    真正被覆盖的旧版永远与新版相邻（两条 assistant 连续），所以只要它后面不是
    assistant（是提问，或者干脆没有下一条），就说明它属于更早的正常轮次，可以安全恢复。
    """
    fixed = 0
    with Session(engine) as session:
        # 1. 只碰「确实有旧版标记」的会话：修好之后这条查询返回空，启动不再扫全库
        conversation_ids = session.exec(
            select(ChatMessage.conversation_id)
            .where(ChatMessage.role == "assistant", ChatMessage.superseded == 1)
            .distinct()
        ).all()
        if not conversation_ids:
            return 0
        # 2. 一次取出这些会话的全部 (id, role, 版本标记)，在内存里看「下一条」。
        #    原来对每条旧版都单独查一次下一条，老库几千条就是几千次往返。
        rows = session.exec(
            select(ChatMessage.id, ChatMessage.conversation_id, ChatMessage.role, ChatMessage.superseded)
            .where(ChatMessage.conversation_id.in_([int(item) for item in conversation_ids]))
            .order_by(ChatMessage.conversation_id.asc(), ChatMessage.id.asc())
        ).all()
        restore: list[int] = []
        for index, row in enumerate(rows):
            if row.role != "assistant" or int(row.superseded or 0) != 1:
                continue
            following = rows[index + 1] if index + 1 < len(rows) else None
            same_conversation = following is not None and following.conversation_id == row.conversation_id
            if not same_conversation or following.role != "assistant":
                restore.append(int(row.id))
        # 3. 逐条走 ORM 更新：量级是「被误标的条数」，不是聊天总量
        for message_id in restore:
            current = session.get(ChatMessage, message_id)
            if current is not None:
                current.superseded = 0
                session.add(current)
        fixed = len(restore)
        if fixed:
            session.commit()
    return fixed


def list_conversations(
    user_id: int | None,
    limit: int = 100,
    offset: int = 0,
    before_time: int | None = None,
    before_id: int | None = None,
) -> list[dict]:
    """会话列表：按 update_time 倒序；匿名只见匿名会话，登录只见自己的。

    默认截断到最新 100 条：攒到几百上千条时把 id/title/时间全量返回只是浪费带宽和前端渲染，
    侧栏本来就只展示最近的一批。

    翻更早的优先用 keyset（before_time + before_id）：排序键 update_time 会被「说了一句话」
    改写，用 offset 时翻页期间有会话被更新就会重复或漏条。offset 保留是为了兼容旧调用方。
    """
    limit = max(1, min(int(limit), CONVERSATIONS_MAX_LIMIT))
    offset = max(0, int(offset))
    with Session(engine) as session:
        stmt = select(Conversation)
        # 1. 匿名（user_id 为空）与登录用户的会话互相不可见
        stmt = stmt.where(
            Conversation.user_id.is_(None) if user_id is None else Conversation.user_id == user_id
        )
        # 2. update_time 相同秒时用 id 倒序兜底，避免每次请求顺序抖动
        stmt = stmt.order_by(Conversation.update_time.desc(), Conversation.id.desc())
        if before_time is not None or before_id is not None:
            # 两个游标都在时用完整 keyset：同一秒的多条靠 id 继续往前，不用 offset。
            # 只给一个时也必须生效（各按自己那一维过滤）：否则调用方以为翻页了，
            # 实际拿到的是第一页，正好复现注释里要避免的「重复/漏条」
            if before_time is not None and before_id is not None:
                stmt = stmt.where(
                    sa_or(
                        Conversation.update_time < int(before_time),
                        sa_and(
                            Conversation.update_time == int(before_time),
                            Conversation.id < int(before_id),
                        ),
                    )
                )
            elif before_time is not None:
                stmt = stmt.where(Conversation.update_time < int(before_time))
            else:
                stmt = stmt.where(Conversation.id < int(before_id))
            rows = session.exec(stmt.limit(limit)).all()
        else:
            rows = session.exec(stmt.limit(limit).offset(offset)).all()
        return [
            {
                "id": c.id,
                "title": c.title,
                "add_time": c.add_time,
                "update_time": c.update_time,
            }
            for c in rows
        ]


def get_messages(
    conversation_id: int,
    user_id: int | None,
    before_id: int | None = None,
    limit: int = MESSAGES_DEFAULT_LIMIT,
) -> list[dict]:
    """该会话的一页聊天记录（按 id 升序返回）；不是自己的会话抛 HistoryBizError(kind=not_found)。

    默认给最近 limit 条；翻更早的用 keyset（`id < before_id`）而不是 offset——
    流式生成期间新消息会不断追加，offset 会让翻页跳条或重复。
    """
    limit = max(1, min(int(limit), MESSAGES_MAX_LIMIT))
    with Session(engine) as session:
        if _owned(session, conversation_id, user_id) is None:
            raise HistoryBizError("会话不存在")
        stmt = select(ChatMessage).where(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.superseded == 0,  # 被重新生成覆盖掉的旧回复不再回给前端
        )
        if before_id is not None:
            stmt = stmt.where(ChatMessage.id < int(before_id))
        # 先倒序取最近一页，再翻回升序返回（与前端渲染顺序一致，前端靠「条数 == limit」判断还有更早）
        rows = list(session.exec(stmt.order_by(ChatMessage.id.desc()).limit(limit)).all())
        rows.reverse()
        # 2. 附件一次批量取（按 message_id 分桶），不逐条消息再查
        grouped = attachments.by_message_ids(session, [int(m.id) for m in rows if m.id is not None])
        return [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "add_time": m.add_time,
                "model": m.model or "",
                "attachments": grouped.get(int(m.id), []),
            }
            for m in rows
        ]


def delete_conversation(conversation_id: int, user_id: int | None) -> None:
    """删除会话：聊天记录、附件与摘要一起删，只删一半算 bug。"""
    with Session(engine) as session:
        conv = _owned(session, conversation_id, user_id)
        if conv is None:
            raise HistoryBizError("会话不存在")
        # 1. 同一事务先删消息、附件记录与摘要（单条 DELETE，不再逐行 session.delete）
        session.exec(sa_delete(ChatMessage).where(ChatMessage.conversation_id == conversation_id))
        session.exec(sa_delete(ChatSummary).where(ChatSummary.conversation_id == conversation_id))
        orphans = attachments.delete_by_conversation(session, conversation_id)
        session.delete(conv)
        session.commit()
    # 2. 事务成功后再删物理文件：反过来会出现「记录没了、文件还在」或「commit 失败但文件已删」
    attachments.remove_files(orphans)


def rename_conversation(conversation_id: int, title: str, user_id: int | None) -> dict:
    """重命名会话：只改标题，不动 update_time（否则改个名字就把会话顶到最前面）。"""
    name = (title or "").strip()
    if not name:
        raise HistoryBizError("标题不能为空", "invalid")
    with Session(engine) as session:
        conv = _owned(session, conversation_id, user_id)
        if conv is None:
            raise HistoryBizError("会话不存在")
        # 与 conversations.title 的 max_length 对齐：SQLite 不拦长度，超长值会在导出到 MySQL 时炸
        conv.title = clip(name, TITLE_MAX_STORED)
        session.add(conv)
        session.commit()
        return {"id": conv.id, "title": conv.title}


def ensure_owned(conversation_id: int, user_id: int | None) -> None:
    """归属校验出口：不是自己的会话抛 HistoryBizError(kind=not_found)，供只读接口复用。"""
    with Session(engine) as session:
        if _owned(session, conversation_id, user_id) is None:
            raise HistoryBizError("会话不存在")


def claim_conversations(conversation_ids: list[int], user_id: int | None) -> dict:
    """登录后认领匿名会话：只认领仍为匿名且仍在时间窗内的，返回实际认领条数。"""
    # 1. 未登录不允许认领 → 401 中文
    if user_id is None:
        raise HistoryBizError("请先登录后再认领会话", "unauthorized")
    if not conversation_ids:
        return {"claimed": 0}
    # 2. 去重并截断到上限：认领接口不是枚举器，一次最多处理 CLAIM_MAX_IDS 个 id
    ids = list(dict.fromkeys(int(i) for i in conversation_ids))[:CLAIM_MAX_IDS]
    deadline = int(time.time()) - CLAIM_WINDOW_SECONDS
    with Session(engine) as session:
        # 3. 只动 user_id 为空的会话；已属于别人的跳过（互相不可见）。
        #    时间窗之外的匿名会话一律不认领，避免凭猜 id 拿到别人的聊天记录
        found = session.exec(
            select(Conversation.id).where(
                Conversation.id.in_(ids),
                Conversation.user_id.is_(None),
                Conversation.add_time >= deadline,
            )
        ).all()
        # 4. 单条 UPDATE 认领（不逐行 add），并发下也不会把别人的会话改走：条件里仍限 user_id 为空
        claimed = 0
        if found:
            result = session.execute(
                sa_update(Conversation)
                .where(Conversation.id.in_(found), Conversation.user_id.is_(None))
                .values(user_id=user_id)
            )
            # 返回实际改到的行数：并发下这中间可能已被别的进程认领走，
            # 用 len(found) 会报出一个没发生过的数字
            claimed = int(result.rowcount or 0)
        session.commit()
        return {"claimed": claimed}
