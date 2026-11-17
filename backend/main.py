"""FastAPI 应用入口：创建 app、挂载路由；lifespan 启动时幂等建业务表。

启动：uv run uvicorn main:app --host 127.0.0.1 --port 8010
"""
import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from core import history
from core import user as user_service
from core import migrations
from core.attachments import cleanup_orphans, migrate_legacy_uploads
from core.chat import stop_summary_worker
from core.database import engine
from core.db_info import data_dir, describe
from core.errors import BizError, status_of
from core.files import MAX_TOTAL_BYTES, MULTIPART_OVERHEAD, cleanup_stale_spool
from core.security import ensure_jwt_config
from routers import attachments, chat, conversations, health, user

logger = logging.getLogger(__name__)

# 日志基础配置（唯一源）：不配的话 root 默认 WARNING 且无 handler，
# 本工程所有 logger.info（首字耗时、摘要刷新、上下文降级）都会被吞掉，排查性能问题时等于没有日志。
# uvicorn 只配自己的 logger，不管应用日志，所以这里必须自己配一次。
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
# httpx / httpx2 / httpcore 会把每次出站请求打成 INFO（含模型服务地址），对排障没帮助还刷屏，压到 WARNING
for _noisy_logger in ("httpx", "httpx2", "httpcore"):
    logging.getLogger(_noisy_logger).setLevel(logging.WARNING)

# 统一 API 前缀（统一前缀）
API_PREFIX = "/api/v1"
# 上传接口路径（体积预检放宽到文件上限）
UPLOAD_PATH = f"{API_PREFIX}/chat_upload"
# JSON 接口的 body 上限：正文上限是 4000 字，2MB 对正常请求绰绰有余。
# 不设的话 Starlette 会先把整包读进内存再交给 Pydantic，一个超大 JSON POST 就能打高内存
JSON_BODY_MAX_BYTES = 2 * 1024 * 1024
# 视为「只有本机能访问」的监听地址（空值按默认回环处理）
_LOOPBACK_HOSTS = {"", "127.0.0.1", "localhost", "::1"}


def demo_login_exposed() -> bool:
    """监听非回环地址 + 验证码回显同时成立 → 局域网内任何人都能登录任意账号。

    验证码模式的判断必须走 core.user._demo_code_mode()：它每次读环境变量，是唯一口径；
    在这里再写一遍 os.environ.get('DEMO_CODE_MODE', '0') 会让两处默认值慢慢漂开。
    局限：uvicorn 命令行 --host 优先于 .env，本检查只覆盖 start.ps1 按 BACKEND_HOST 启动的路径。
    """
    host = os.environ.get("BACKEND_HOST", "").strip().lower()
    return host not in _LOOPBACK_HOSTS and user_service._demo_code_mode()


def _start_cleanup_in_background() -> None:
    """后台清理孤儿附件与上传暂存残留；任何失败只记日志，绝不影响服务与退出。

    清的都是「7 天前 / 24 小时前」的残留，不存在与正在进行的上传抢文件的情况；
    daemon 线程随进程退出，不需要额外 join。
    """

    def _run() -> None:
        try:
            cleanup_orphans()
        except Exception:  # noqa: BLE001
            logger.exception("孤儿附件清理失败（服务不受影响）")
        try:
            cleanup_stale_spool(data_dir() / "tmp")
        except Exception:  # noqa: BLE001
            logger.exception("上传暂存清理失败（服务不受影响）")

    threading.Thread(target=_run, name="startup-cleanup", daemon=True).start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 0. 启动即校验 JWT 配置（密钥长度与有效期）：留到「用的时候才发现」就会变成
    #    「服务起得来、一登录 500」，新人排查成本极高
    ensure_jwt_config()
    # 0a. 数据目录必须先存在：SQLite 文件与附件都落在这里；
    #     MySQL 模式下 uploads 也在这个目录，所以两种后端都要建
    data_dir().mkdir(parents=True, exist_ok=True)
    # 1. 结构对齐（幂等）：新库直接建全，老库补列补索引；真需要改结构时会先自动备份
    schema = migrations.upgrade()
    storage = describe()
    logger.info("数据库：%s（%s）", storage["backend"], storage["location"])
    if schema["columns"] or schema["indexes"]:
        logger.info(
            "结构已升级：补 %d 列、%d 个索引（升级前备份：%s）",
            schema["columns"],
            schema["indexes"],
            schema["backup"],
        )
    else:
        logger.info("结构已是最新（%s）", migrations.schema_fingerprint())
    # 1a. 附件目录按后端分开：老版本是平铺的 uploads/<xx>/<sha>，不分目录的话
    #     切到另一个空库后 cleanup_orphans 会把不属于本库的文件全当孤儿删掉。
    #     只搬当前库引用到的文件；失败不影响启动（文件还在原处，下次启动重试）
    try:
        legacy = migrate_legacy_uploads()
        if legacy["moved"]:
            logger.info("附件目录迁移完成：%s", legacy)
    except Exception:  # noqa: BLE001
        logger.exception("附件目录迁移失败（不影响启动）")
    # 1b. 修历史数据（幂等）：旧版「重新生成」把整会话回答一起降级过，这里把误伤的恢复显示。
    #     失败只打日志：数据修复不该拦住服务启动
    try:
        recovered = history.repair_superseded_flags()
        if recovered:
            logger.info("历史数据修复：%d 条被误标记的回答已恢复显示", recovered)
    except Exception:  # noqa: BLE001
        logger.exception("历史数据修复失败（不影响启动）")
    # 2. 附件清理放到后台线程：这一步要扫整个附件表，几十万条时会把「服务可用」推迟好几秒，
    #    而它删的都是 7 天前/24 小时前的残留，晚几百毫秒没有区别
    _start_cleanup_in_background()
    # 3. 危险组合只告警、不拒绝启动：用户本来就可能在做局域网演示，拦下来会打断他
    if demo_login_exposed():
        logger.error(
            "当前监听非回环地址且开启验证码回显，局域网内任何人都能登录任意账号；"
            "若要给别人演示，请把配置里的 DEMO_CODE_MODE 改为 0"
            "（打包态是 userData/config.env，开发态是 backend/.env）"
        )
    try:
        yield
    finally:
        # 关服清理必须在 finally：原来只有 try 没有 finally，engine 从不 dispose，
        # MySQL 连接不归还、SQLite WAL 不 checkpoint；摘要线程也会被硬切在写库中途
        try:
            stop_summary_worker()
        except Exception:  # noqa: BLE001
            logger.exception("停止摘要线程失败（不影响退出）")
        try:
            engine.dispose()
        except Exception:  # noqa: BLE001
            logger.exception("释放数据库连接失败（不影响退出）")


app = FastAPI(title="随心问答 SuiXinWenDa 后端", lifespan=lifespan)


@app.exception_handler(BizError)
async def biz_error_handler(request: Request, exc: BizError):
    """业务异常兜底：按 KIND_STATUS 出状态码与中文原文。

    为什么要有这一层：路由层是自觉调 routers/common.py 的 call() 的，任何新路由漏写一次，
    BizError 就会落到下面的 Exception handler 变成 500「服务暂时不可用」，
    前端丢掉「该账号已注册」这类可操作文案。这里接住之后，漏写只是「少一层包装」，不会变成 500。
    日志用 debug 不用 exception：业务错误是预期内的分支，不是程序故障，打堆栈只会淹没真异常。
    """
    logger.debug("业务异常 %s %s -> %s：%s", request.method, request.url.path, exc.kind, exc.message)
    return JSONResponse(status_code=status_of(exc.kind), content={"detail": exc.message})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """兜底异常处理：原始异常只进日志，对外一律中文「服务暂时不可用」，绝不回堆栈。"""
    logger.exception("未处理异常 %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "服务暂时不可用，请稍后重试；若持续失败请查看后端日志"},
    )


@app.middleware("http")
async def reject_oversized_upload(request: Request, call_next):
    """上传体积预检：必须放在中间件里才有效。

    路由函数拿到 `file: UploadFile` 时，Starlette 已经把整个 multipart body 读完并落到临时文件；
    只有在分发之前看 `Content-Length` 才能真正省掉收包与落盘。
    分块传输（无 Content-Length）没有这一层保护，仍由 core/files.py 的分块累计读取兜底。
    """
    # 末尾斜杠（/chat_upload/）由 Starlette 重定向到无斜杠，这里同样按无斜杠比对，
    # 否则带斜杠的超大包会绕过预检、被读完再进路由
    declared = request.headers.get("content-length")
    size = int(declared) if declared and declared.isdigit() else 0
    if request.url.path.rstrip("/") == UPLOAD_PATH:
        # 放宽 multipart 边界开销，避免「刚好到上限」的正常文件被误拒
        if size > MAX_TOTAL_BYTES + MULTIPART_OVERHEAD:
            return JSONResponse(
                status_code=413,
                content={"detail": f"所有文件合计不能超过 {MAX_TOTAL_BYTES // (1024 * 1024)} MB"},
            )
    elif request.method in ("POST", "PUT", "PATCH"):
        # 无 Content-Length 的请求体（chunked）绕不过这一层：分块传输没有声明长度，
        # 上面那条 size 判断永远是 0。JSON 接口不排除有正当的 chunked 客户端，
        # 但本项目只有自家的 fetch（一定带长度），所以直接拒绝比「读完整包再截断」更安全。
        if not declared and request.headers.get("transfer-encoding"):
            return JSONResponse(
                status_code=411,
                content={"detail": "请求必须声明 Content-Length（不支持分块上传）"},
            )
        if size > JSON_BODY_MAX_BYTES:
            return JSONResponse(
                status_code=413,
                content={"detail": f"请求内容过大（上限 {JSON_BODY_MAX_BYTES // (1024 * 1024)} MB）"},
            )
    return await call_next(request)


app.include_router(health.router, prefix=API_PREFIX)
app.include_router(user.router, prefix=API_PREFIX)
app.include_router(chat.router, prefix=API_PREFIX)
app.include_router(conversations.router, prefix=API_PREFIX)
app.include_router(attachments.router, prefix=API_PREFIX)
