"""业务异常映射测试：KIND_STATUS 是状态码的唯一来源，改错一行就会让整片接口状态码静默走偏。"""
from core.errors import KIND_STATUS, BizError, status_of


def test_status_of_each_known_kind():
    """已登记的 kind 全部按表映射（唯一源 = core.errors.KIND_STATUS）。"""
    assert status_of("invalid") == 400
    assert status_of("unsupported") == 400
    assert status_of("parse_error") == 400
    assert status_of("conflict") == 409, "冲突用 409：400 会让前端分不清参数错与已存在"
    assert status_of("unauthorized") == 401
    assert status_of("not_found") == 404
    assert status_of("too_many") == 429, "失败次数超限用 429，前端才能给出「等几分钟再试」"
    assert status_of("too_large") == 413


def test_status_of_unknown_kind_falls_back_to_400():
    """未登记的 kind 兜底 400：业务异常绝不能变成 500。"""
    assert status_of("没登记过的kind") == 400
    assert status_of("") == 400


def test_biz_error_carries_message_and_kind():
    """BizError 同时带用户可见文案与 kind，路由层只查表不再各自维护映射。"""
    error = BizError("文件解压后过大，请压缩内容后再上传", "too_large")
    assert str(error) == "文件解压后过大，请压缩内容后再上传"
    assert error.message == "文件解压后过大，请压缩内容后再上传"
    assert error.kind == "too_large"
    assert status_of(error.kind) == 413


def test_biz_error_default_kind_is_invalid():
    """缺省 kind = invalid（400），与「参数不合法」语义一致。"""
    error = BizError("参数不合法")
    assert error.kind == "invalid"
    assert status_of(error.kind) == 400


def test_kind_status_table_has_no_unexpected_entries():
    """表内容固定，新增 kind 必须同时补一条用例（防止悄悄塞入非 4xx 的状态码）。"""
    assert KIND_STATUS == {
        "invalid": 400,
        "unsupported": 400,
        "parse_error": 400,
        "conflict": 409,
        "unauthorized": 401,
        "not_found": 404,
        "too_many": 429,
        "too_large": 413,
    }


def test_biz_error_raised_directly_is_not_500():
    """全局 handler 兜住「路由忘了用 call() 包一层」的情况：BizError 直接抛也不会退化成 500。

    这里刻意不走任何路由（路由都自觉包了 call()），用一个临时挂上去的端点验证中间件层行为。
    """
    from fastapi import APIRouter
    from fastapi.testclient import TestClient

    from core.errors import BizError
    from main import app

    router = APIRouter()

    @router.get("/api/v1/__test_biz_conflict")
    def _conflict_probe():
        raise BizError("该账号已注册", "conflict")

    app.include_router(router)
    try:
        response = TestClient(app).get("/api/v1/__test_biz_conflict")
    finally:
        # 这个路由只服务于本用例，用完就摘掉，别污染其它用例的路由表
        app.router.routes = [
            route for route in app.router.routes if getattr(route, "path", "") != "/api/v1/__test_biz_conflict"
        ]

    assert response.status_code == 409, "BizError 必须按 KIND_STATUS 出状态码，不能落进 500 兜底"
    assert response.json()["detail"] == "该账号已注册", "文案要原样保留中文，不要被兜底文案替换"
