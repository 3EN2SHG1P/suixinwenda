"""请求头鉴权依赖：解析 Bearer JWT 得当前用户 id；不带头 = 匿名。"""
from fastapi import Header, HTTPException
from sqlmodel import Session

from core.database import engine
from core.security import decode_token
from models import User

# 令牌无效（格式/签名/过期/sub 非数字）统一 401 同一句中文，不暴露内部原因。
# 公开给需要「必须已登录」的路由复用（如 PATCH /me），避免各处再抄一份文案。
INVALID_TOKEN = "登录状态无效，请重新登录"
_INVALID_TOKEN = INVALID_TOKEN


def current_user_id(authorization: str | None = Header(default=None)) -> int | None:
    """从 Authorization 头取当前用户 id；缺头返回 None（匿名），坏头 401 中文。"""
    # 1. 无头 = 匿名请求
    if not authorization or not authorization.strip():
        return None
    # 2. 校验 Bearer 前缀与令牌本体
    scheme, _, token = authorization.strip().partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail=_INVALID_TOKEN)
    # 3. 校验签名与过期；sub 必须是正整数，任何异常一律 401（不能变成 500）
    try:
        payload = decode_token(token.strip())
        user_id = int(payload["sub"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=401, detail=_INVALID_TOKEN)
    if user_id <= 0:
        raise HTTPException(status_code=401, detail=_INVALID_TOKEN)
    # 4. 账号状态：令牌签发后可能被禁用或删号，不能在有效期内继续可用
    #    禁用也回同一句「登录状态无效」：不向持令人区分「令牌坏了」与「账号被封」，
    #    登录时那条明确的中文由 _ensure_enabled 负责。
    #    不加缓存：单人本机，一次主键查询可忽略。
    with Session(engine) as session:
        user = session.get(User, user_id)
    if user is None or user.status != 1:
        raise HTTPException(status_code=401, detail=_INVALID_TOKEN)
    return user_id
