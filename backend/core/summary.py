"""会话摘要：把「保留窗口之外」的早期轮次压成一段中文摘要，落 chat_summaries。

并发口径（唯一）：写入用 CAS（乐观锁），绝不加行锁——
`UPDATE ... WHERE conversation_id = ? AND covered_message_id = 读到的旧值`，
抢不到就放弃本次（进度没前进，下一轮会重算，不丢增量）。
`covered_rounds` 与 `covered_message_id` 必须在同一条 SQL 里一起前进，
禁止 ON DUPLICATE KEY UPDATE + GREATEST：那会让两列各自前进而互相错配。
"""
import logging
import time

from langchain_core.messages import HumanMessage, SystemMessage
from sqlalchemy import or_, update as sa_update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, select

from core.context import SUMMARY_INPUT_MAX_CHARS, SUMMARY_MAX_CHARS, plan_refresh
from core.database import engine, is_retryable_lock_error
from models import ChatMessage, ChatSummary, Conversation

logger = logging.getLogger(__name__)

# SQLite 的「database is locked」是等一下就能成，CAS 抢占则是别人已经推进了进度（该放弃）。
# 两者混在一个 except 里，锁冲突就会表现成「摘要永远不刷新，日志只有一行被忽略」。
_LOCK_RETRY_WAITS = (0.2, 0.5, 1.0)

# 摘要提示词（本文件自持：摘要由后台任务直接调模型生成，不经过任何 LangGraph 钩子）
SUMMARY_PROMPT = (
    "把以下对话历史压缩成一段中文摘要，保留关键事实与结论，忽略没有回答的提问，只输出摘要正文。"
)


def summary_row(conversation_id: int) -> tuple[str, int, int]:
    """一次查询取三列：返回 (summary, covered_message_id, covered_rounds)；没有行返回 ("", 0, 0)。

    读失败只打日志返回空值：摘要只是上下文增益，不能让一次查库抖动毁掉整轮对话。
    """
    try:
        with Session(engine) as session:
            row = session.get(ChatSummary, conversation_id)
    except Exception:  # noqa: BLE001
        logger.warning("读取摘要失败（按无摘要处理）conversation_id=%s", conversation_id, exc_info=True)
        return "", 0, 0
    if row is None:
        return "", 0, 0
    return (
        str(row.summary or ""),
        int(row.covered_message_id or 0),
        int(row.covered_rounds or 0),
    )


def summary_for(conversation_id: int) -> str:
    """只要摘要文本：直接复用 summary_row 的查询，不另写一条 SQL。"""
    return summary_row(conversation_id)[0]


def _condense_prompt(old_summary: str, lines: list[str]) -> str:
    """把「已有摘要 + 新增对话」拼成 prompt 正文，并对总长做截断。

    截断顺序是有讲究的：
    - 旧摘要优先保留：它是之前几十轮的压缩结果，砍掉等于把最老的事实整段丢掉；
    - 新增对话从最新往回取：summary 的用途是「接上最近发生的事」，先丢旧的才对；
    - 取不下的一行整行丢掉，不做半句截断——半句话进摘要会变成错误事实。
    上限只放在本函数里读模块常量，测试才能用 monkeypatch 注入小阈值覆盖这条分支。
    """
    parts: list[str] = []
    budget = SUMMARY_INPUT_MAX_CHARS
    if old_summary:
        head = f"（已有摘要）{old_summary}"[:budget]
        parts.append(head)
        budget -= len(head)
    mark = "（新增对话）\n"
    budget -= len(mark)
    if budget > 0:
        picked: list[str] = []
        used = 0
        # 从最新一条往回取：反过来取会把「最近几轮」挤掉，只留下早就不再相关的旧内容
        for line in reversed(lines):
            need = len(line) + 1
            if used + need > budget:
                break
            picked.append(line)
            used += need
        if picked:
            parts.append(mark + "\n".join(reversed(picked)))
        if len(picked) < len(lines):
            logger.warning(
                "摘要输入超过 %d 字，已截断：保留旧摘要 + 最近 %d/%d 条消息",
                SUMMARY_INPUT_MAX_CHARS,
                len(picked),
                len(lines),
            )
    return "\n\n".join(parts)


def _condense(model, old_summary: str, lines: list[str]) -> str:
    """把「已有摘要 + 新增对话」压成一段不超过 SUMMARY_MAX_CHARS 的中文摘要。"""
    try:
        reply = model.invoke(
            [
                SystemMessage(content=SUMMARY_PROMPT),
                HumanMessage(content=_condense_prompt(old_summary, lines)),
            ]
        )
    except Exception:  # noqa: BLE001
        logger.exception("生成摘要失败，本次不写摘要")
        return ""
    content = getattr(reply, "content", "")
    text = content if isinstance(content, str) else str(content)
    return _clip_summary(text.strip())


def _clip_summary(text: str) -> str:
    """按完整句子截断摘要：硬切会在末尾留下半句，而半句话进下一轮上下文就是错误事实。

    与本文件 `_condense_prompt` 的「不做半句截断」口径保持一致：
    只在后半段里找最近一个句读/换行，找不到（模型一次吐出超长单句）才退回硬截断。
    """
    if len(text) <= SUMMARY_MAX_CHARS:
        return text
    head = text[:SUMMARY_MAX_CHARS]
    cut = max(head.rfind(char) for char in "。！？；\n")
    if cut >= SUMMARY_MAX_CHARS // 2:
        return head[: cut + 1]
    return head


def refresh_latest(conversation_id: int, model) -> None:
    """后台 worker 的入口：执行时现算一次节流，够一批才刷新。

    计划（upto 与覆盖轮数）必须在同一时刻成对取到，所以这里调 plan_refresh，
    再把配套的一对值传给 refresh——refresh 内部禁止再取一次游标，否则两列会错配。
    """
    should, upto_message_id, cover_rounds_after = plan_refresh(conversation_id)
    if not should:
        return
    logger.info(
        "排摘要刷新（conversation_id=%s，upto=%s，覆盖轮数=%s）",
        conversation_id,
        upto_message_id,
        cover_rounds_after,
    )
    refresh(
        conversation_id,
        model,
        upto_message_id=upto_message_id,
        cover_rounds_after=cover_rounds_after,
    )


def refresh(
    conversation_id: int,
    model,
    *,
    upto_message_id: int,
    cover_rounds_after: int,
) -> None:
    """把 (旧覆盖上界, upto_message_id) 之间的 active 消息并入摘要（幂等 + CAS）。

    调用方必须一次算好 upto_message_id 与 cover_rounds_after 传进来：
    本函数内部绝不再调 round_cursor()——两次取值之间进来一条新提问，两列就会错配。
    全程失败只记日志，不抛给调用方。
    """
    for wait in (*_LOCK_RETRY_WAITS, None):
        try:
            _refresh(
                conversation_id,
                model,
                upto_message_id=int(upto_message_id),
                cover_rounds_after=int(cover_rounds_after),
            )
            return
        except OperationalError as error:
            if not is_retryable_lock_error(error):
                logger.exception("摘要刷新失败（已忽略）conversation_id=%s", conversation_id)
                return
            if wait is None:
                logger.warning(
                    "摘要刷新连续 %d 次遇到数据库锁，本次放弃 conversation_id=%s",
                    len(_LOCK_RETRY_WAITS),
                    conversation_id,
                )
                return
            logger.info("摘要刷新遇到数据库锁，%.1f 秒后重试 conversation_id=%s", wait, conversation_id)
            time.sleep(wait)
        except Exception:  # noqa: BLE001
            logger.exception("摘要刷新失败（已忽略）conversation_id=%s", conversation_id)
            return


def _refresh(conversation_id: int, model, *, upto_message_id: int, cover_rounds_after: int) -> None:
    # 1. 读当前行（一次查询拿到三列 + 是否已有行）
    with Session(engine) as session:
        if session.get(Conversation, conversation_id) is None:
            return  # 会话已删：静默退出，别给幽灵会话留摘要
        row = session.get(ChatSummary, conversation_id)
        if row is None:
            old_summary, old_covered_id, old_rounds, has_row = "", 0, 0, False
        else:
            old_summary = str(row.summary or "")
            old_covered_id = int(row.covered_message_id or 0)
            old_rounds = int(row.covered_rounds or 0)
            has_row = True
    # 2. 没有新区间直接返回
    if upto_message_id <= old_covered_id:
        return
    # 3. 取覆盖区间内的 active 消息（作废回答不进摘要）。
    #    下界是开区间，但上界那条提问本身属于「下一轮的第一问」，上一批明确没把它包含进去
    #    （区间是 (旧上界, 新上界) 开区间）。只补 id 相等的 user 一行即可：
    #    否则每次刷新都会把边界那一问永久丢掉，而它的回答却被下一批收进摘要——
    #    摘要里会出现「有答无问」的孤立结论，看起来像模型记错了问题。
    with Session(engine) as session:
        rows = session.exec(
            select(ChatMessage)
            .where(
                ChatMessage.conversation_id == conversation_id,
                ChatMessage.superseded == 0,
                or_(
                    ChatMessage.id > old_covered_id,
                    (ChatMessage.id == old_covered_id) & (ChatMessage.role == "user"),
                ),
                ChatMessage.id < upto_message_id,
            )
            .order_by(ChatMessage.id.asc())
        ).all()
        lines = [f"{row.role}：{row.content}" for row in rows]
    # 3b. 空区间不能写成「已覆盖」：否则那段消息永远进不了摘要
    if not lines:
        return
    # 4. 压摘要（锁外进行，不占用任何行锁）
    summary = _condense(model, old_summary, lines)
    if not summary:
        return
    # 5. 两列一起前进：轮数取历史最大值，避免并发下回退
    new_rounds = max(old_rounds, cover_rounds_after)
    now = int(time.time())
    # 6. 写回
    with Session(engine) as session:
        if session.get(Conversation, conversation_id) is None:
            return
        if not has_row:
            session.add(
                ChatSummary(
                    conversation_id=conversation_id,
                    summary=summary,
                    covered_message_id=upto_message_id,
                    covered_rounds=new_rounds,
                    add_time=now,
                )
            )
            try:
                session.commit()
            except IntegrityError:
                # 别人抢先建了同一行：放弃本次，不重试（进度未前进，下轮重算）
                session.rollback()
                logger.info("摘要插入冲突，放弃本次 conversation_id=%s", conversation_id)
            except Exception:  # noqa: BLE001
                # 锁冲突/字段超长/连接断这类真实错误不能被当成 CAS 冲突静默吞掉：
                # 只捕获 IntegrityError 之后，这里必须留痕，否则摘要会「永远不刷新且无日志」
                session.rollback()
                logger.exception("摘要写入失败（已忽略）conversation_id=%s", conversation_id)
            return
        result = session.execute(
            sa_update(ChatSummary)
            .where(
                ChatSummary.conversation_id == conversation_id,
                ChatSummary.covered_message_id == old_covered_id,
            )
            .values(
                summary=summary,
                covered_message_id=upto_message_id,
                covered_rounds=new_rounds,
                add_time=now,
            )
        )
        if result.rowcount == 0:
            session.rollback()
            logger.info("摘要 CAS 失败（已被其它任务更新），放弃本次 conversation_id=%s", conversation_id)
            return
        session.commit()
