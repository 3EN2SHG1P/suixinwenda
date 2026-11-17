"""业务异常基座：core 层只抛 BizError，由路由层统一映射 HTTP 状态码。

统一入口的好处：新增一种业务异常不必再抄一遍「message + kind」结构与状态码表，
路由层也不再各自维护一份 `_KIND_STATUS`（同一概念只有一个出处）。
"""

# kind → HTTP 状态码（唯一映射表；路由层只查这里）
KIND_STATUS = {
    "invalid": 400,  # 参数/验证码类
    "unsupported": 400,  # 不支持的文件格式
    "parse_error": 400,  # 文件解析失败
    "conflict": 409,  # 资源冲突（账号已注册等）：400 会让前端分不清「参数错」与「已存在」
    "unauthorized": 401,  # 凭据错误 / 未登录
    "not_found": 404,  # 资源不存在或不属于当前用户
    "too_many": 429,  # 请求过于频繁 / 失败次数超限（带重试等待语义，别混进 400）
    "too_large": 413,  # 超过大小上限
}

# 未知 kind 的兜底状态码（宁可 400，也不要把业务异常变成 500）
DEFAULT_STATUS = 400


class BizError(Exception):
    """业务异常：message 给用户看（中文），kind 供路由层查表得 HTTP 状态码。"""

    def __init__(self, message: str, kind: str = "invalid"):
        super().__init__(message)
        self.message = message
        self.kind = kind


def status_of(kind: str) -> int:
    """取 kind 对应的 HTTP 状态码；未登记的 kind 一律按 400 处理。"""
    return KIND_STATUS.get(kind, DEFAULT_STATUS)
