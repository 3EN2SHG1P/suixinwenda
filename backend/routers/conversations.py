"""会话组接口：列表 / 完整聊天记录 / 删除 / 模型记忆 / 匿名认领（鉴权）。"""
import logging

from fastapi import APIRouter, Depends, Query
from langchain_core.messages import AIMessage, HumanMessage

from core import context, history
from routers.common import call
from routers.deps import current_user_id
from schemas.conversation import ClaimIn, RenameIn

logger = logging.getLogger(__name__)

router = APIRouter()


def _memory_payload(message, images: list[dict] | None = None) -> dict:
    """把一条上下文消息转成弹窗用的 {role, content, images}：content 只取文本段。

    images 是这条消息带过的图片附件（id / 文件名 / 本轮是否重放给模型），
    弹窗据此显示缩略图；元数据不给模型看，只给界面用。
    """
    content = getattr(message, "content", "")
    if isinstance(content, list):
        text = "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    else:
        text = str(content or "")
    if isinstance(message, HumanMessage):
        role = "user"
    elif isinstance(message, AIMessage):
        role = "assistant"
    else:
        role = "system"
    payload = {"role": role, "content": text}
    if images:
        payload["images"] = [
            {
                "id": int(item.get("id") or 0),
                "name": str(item.get("name") or ""),
                "replayed": bool(item.get("replayed")),
            }
            for item in images
        ]
    return payload


@router.get("/conversations")
def conversations(
    limit: int = Query(history.CONVERSATIONS_DEFAULT_LIMIT, ge=1, le=history.CONVERSATIONS_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    before_time: int | None = Query(None, ge=0),
    before_id: int | None = Query(None, ge=1),
    user_id: int | None = Depends(current_user_id),
):
    """会话列表，按 update_time 倒序；匿名与登录互相不可见。

    分页只影响「一次返回多少」，响应仍是数组：前端靠「返回条数 == limit」判断还有没有下一页，
    不额外包一层 {items,total}（那要同步改 mock-server 与冒烟断言，纯 churn）。

    翻页优先用 before_time + before_id（keyset）：update_time 会被新消息改写，offset 翻页
    在「翻页期间有人说话」时会重复或漏条。两个都不传时行为与旧版完全一致。
    """
    return call(
        history.list_conversations,
        user_id,
        limit,
        offset,
        before_time=before_time,
        before_id=before_id,
    )


@router.get("/conversations/{conversation_id}/messages")
def conversation_messages(
    conversation_id: int,
    limit: int = Query(history.MESSAGES_DEFAULT_LIMIT, ge=1, le=history.MESSAGES_MAX_LIMIT),
    before_id: int | None = Query(None, ge=1),
    user_id: int | None = Depends(current_user_id),
):
    """该会话的一页聊天记录（升序数组）；带 before_id 往前翻更早一页。

    响应不包信封：前端靠「返回条数 == limit」判断还有没有更早的（与列表分页同一套口径）。
    """
    return call(history.get_messages, conversation_id, user_id, before_id, limit)


@router.post("/conversations/{conversation_id}/revert")
def revert_regenerate(conversation_id: int, user_id: int | None = Depends(current_user_id)):
    """回退一步：重新生成后不满意，恢复上一版回答（内容留在库里，不需要重新请求模型）。"""
    return call(history.revert_last_regenerate, conversation_id, user_id)


@router.patch("/conversations/{conversation_id}")
def rename_conversation(
    conversation_id: int, payload: RenameIn, user_id: int | None = Depends(current_user_id)
):
    """重命名会话；不是自己的按 404 处理。"""
    return call(history.rename_conversation, conversation_id, payload.title, user_id)


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: int, user_id: int | None = Depends(current_user_id)):
    """删除会话：聊天记录与模型记忆一起删；不是自己的按 404 处理。"""
    call(history.delete_conversation, conversation_id, user_id)
    return {"message": "会话已删除"}


@router.get("/conversations/{conversation_id}/memory")
def conversation_memory(conversation_id: int, user_id: int | None = Depends(current_user_id)):
    """模型当前记忆：直接复用 load_context，与模型实际上下文天然一致。

    已知表现（不是 bug）：弹窗里会包含你刚发、还没被回答的那条提问——模型这一轮确实看到了它。
    """
    call(history.ensure_owned, conversation_id, user_id)
    try:
        view = context.load_context_view(conversation_id)
    except Exception:  # noqa: BLE001
        # 弹窗显示「还没有消息」好过报错：这里没有本轮内容可退，降级链会直接抛。
        # degraded 让前端能区分「真的没有消息」与「构建失败」——只返回空列表时，
        # 库坏了用户看到的是「还没有消息」，问题永远不会被报出来。
        logger.warning(
            "构建对话历史失败，返回空列表（conversation_id=%s）", conversation_id, exc_info=True
        )
        return {"messages": [], "degraded": True}
    return {
        "messages": [_memory_payload(item["message"], item["images"]) for item in view],
        "degraded": False,
    }


@router.post("/conversations/claim")
def claim(payload: ClaimIn, user_id: int | None = Depends(current_user_id)):
    """登录后认领匿名会话；未登录 401 中文。"""
    return call(history.claim_conversations, payload.conversation_ids, user_id)
