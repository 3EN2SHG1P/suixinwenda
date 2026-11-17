"""附件接口：下载原文件 / 读抽取正文。

鉴权口径与消息接口一致：先按 id 取附件，再用附件所属会话做归属校验（不是自己的按 404）。
下载走 `FileResponse`（不用 StaticFiles：静态挂载无法按用户校验归属）。
"""
from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from core import attachments, history
from core.errors import BizError
from routers.common import call, raise_biz
from routers.deps import current_user_id

router = APIRouter()

# 记录还在、文件被手动删掉时的中文提示（不暴露磁盘路径）
GONE_TEXT = "附件文件已不存在，可能是本机缓存被清理过"


def _load(attachment_id: int, user_id: int | None):
    """取附件并校验归属：不存在 / 不是自己的，一律 404。"""
    row = call(attachments.get_row, attachment_id)
    call(history.ensure_owned, row.conversation_id, user_id)
    return row


@router.get("/attachments/{attachment_id}")
def download_attachment(attachment_id: int, user_id: int | None = Depends(current_user_id)):
    """原文件流：图片走灯箱、PDF / 文档走「用系统程序打开」都取这条。"""
    row = _load(attachment_id, user_id)
    path = call(attachments.resolve_path, row)
    if not path.exists():
        # 走统一错误映射：与其它接口一样由 BizError → 中文 detail，不在路由层直接拼 HTTPException
        raise_biz(BizError(GONE_TEXT, "not_found"))
    return FileResponse(
        path,
        # 白名单收敛：库里的 mime 可能来自请求体/历史包，原样回 text/html 就是同源 XSS
        media_type=attachments.safe_download_mime(row.mime),
        filename=row.name,
        content_disposition_type="inline",
        headers={
            # 双保险：即便某天白名单漏了某个类型，也不让浏览器自行嗅探成可执行内容
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.get("/attachments/{attachment_id}/text")
def read_attachment_text(attachment_id: int, user_id: int | None = Depends(current_user_id)):
    """抽取正文（与送模型的文本同源）；truncated=true 表示只保留了前 N 字。"""
    row = _load(attachment_id, user_id)
    return {
        "id": row.id,
        "name": row.name,
        "mime": row.mime,
        "size": row.size,
        "kind": row.kind,
        "text": row.text_excerpt,
        "truncated": bool(row.truncated),
    }
