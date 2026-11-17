"""账号接口层：五个账号路由，业务在 core/user.py，本层只做状态码映射。"""
from fastapi import APIRouter, Depends, HTTPException

from core import user as user_service
from routers.common import call
from routers.deps import INVALID_TOKEN, current_user_id
from schemas.user import LoginByCodeIn, LoginIn, RegisterIn, RenameIn, SendCodeIn

router = APIRouter()


@router.post("/send_code")
def send_code(payload: SendCodeIn):
    """发验证码（默认只写服务端日志，`DEMO_CODE_MODE=1` 时才随响应回显）。注册已不需要，保留兼容。"""
    return call(user_service.send_code, payload.username)


@router.post("/register")
def register(payload: RegisterIn):
    """注册：账号 + 密码即可，直接返回令牌与用户信息（昵称、验证码都是可选项）。"""
    return call(
        user_service.register,
        payload.username,
        payload.password,
        payload.code,
        payload.nickname,
    )


@router.post("/login")
def login(payload: LoginIn):
    """密码登录：返回 JWT 令牌与用户信息。"""
    return call(user_service.login, payload.username, payload.password)


@router.post("/login_by_code")
def login_by_code(payload: LoginByCodeIn):
    """验证码登录：不存在自动注册，返回 is_new_user（演示/兼容保留）。"""
    return call(user_service.login_by_code, payload.username, payload.code)


@router.patch("/me")
def rename_me(payload: RenameIn, user_id: int | None = Depends(current_user_id)):
    """改昵称：必须已登录；匿名请求直接 401，不留「匿名账号」这种中间态。"""
    if user_id is None:
        raise HTTPException(status_code=401, detail=INVALID_TOKEN)
    return call(user_service.rename, user_id, payload.nickname)
