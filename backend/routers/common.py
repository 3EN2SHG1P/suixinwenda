"""路由公共工具：把 core 层的 BizError 统一转成 4xx + 中文 detail。

所有路由组共用这一个出口，避免每个 routers/*.py 各写一份 `_call` 与状态码表。
"""
from typing import NoReturn

from fastapi import HTTPException

from core.errors import BizError, status_of


def call(func, *args, **kwargs):
    """调用业务函数；捕获 BizError 并按其 kind 映射 HTTP 状态码。"""
    try:
        return func(*args, **kwargs)
    except BizError as exc:
        raise HTTPException(status_code=status_of(exc.kind), detail=exc.message)


def raise_biz(exc: BizError) -> NoReturn:
    """把一个已捕获的 BizError 直接转成 HTTPException。

    给「业务调用前后还要夹别的逻辑」的路由用（如上传要先关文件句柄），
    避免各处再抄一遍状态码映射。
    """
    raise HTTPException(status_code=status_of(exc.kind), detail=exc.message)
