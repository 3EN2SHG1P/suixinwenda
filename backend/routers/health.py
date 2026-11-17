"""健康检查接口：GET /api/v1/health，供前端探测后端连接。"""
import os

from fastapi import APIRouter, Request

from core import db_info
from core.database import probe

router = APIRouter()

# 只有本机调用才回「连接明细」：桌面端设置页要回显 host/user/CA 路径，
# 但这些字段（尤其 ssl_ca 的绝对路径）不该被局域网内任何一台机器读到
_LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "localhost", "testclient"}


@router.get("/health")
def health(request: Request):
    """健康检查：进程活着 + 库能不能读。code 恒为 0。

    code 必须恒为 0：start.ps1 与前端都靠它判断「后端起没起来」，
    库的状态是另一件事，混进这个信号会让「库坏了」表现成「后端没启动」。
    managed 说明这个进程是不是桌面端拉起的：桌面端只清理自己那一份残留，
    只凭「端口能连上」就杀，会把 start.ps1 手动启动的开发后端一起杀掉。
    """
    database = {**db_info.describe(), "ok": probe()}
    data = {
        "db": database,
        "managed": os.environ.get("SUIXINWENDA_MANAGED") == "1",
        "pid": os.getpid(),
    }
    client = (request.client.host if request.client else "") or ""
    if client not in _LOOPBACK_CLIENTS:
        # 非本机调用：连接明细（含 CA 绝对路径）与进程号都不给出去，只留 backend/location 供探活判断。
        # pid 只在桌面端「清理自己上次崩溃的残留」时才用，而桌面端永远走回环（见 backend-manager）
        database.pop("connection", None)
        data.pop("pid", None)
    return {"code": 0, "message": "服务正常", "data": data}
