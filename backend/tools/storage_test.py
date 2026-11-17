"""测试一组 MySQL 连接参数是否可用（桌面端「测试连接」的真正实现）。

密码从环境变量读：命令行参数在进程列表里明文可见，等于把口令写进系统日志。
所有参数都走环境变量，argv 里只有程序名，没有任何敏感信息。
"""
from tools import emit
import os
import sys
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text

from core.db_info import LOCAL_HOSTS

# 原始异常 → 用户能照做的中文。禁止把 pymysql 原文直接回给界面（含主机名与库名细节）。
# 顺序有意义：越具体的分支越靠前（「using password: NO」必须先于通用的 Access denied 命中）。
ERROR_HINTS = (
    (
        "using password: no",
        "密码为空：这个账号需要密码，请在连接表单里填写（本机 MySQL 是空密码的话请先给它设一个）",
    ),
    (
        "using password: yes",
        "密码不对：请核对这个账号的密码（Docker 路线默认是 123456）",
    ),
    ("Access denied", "用户名或密码不对"),
    (
        "Unknown database",
        "库不存在，请先执行 CREATE DATABASE ... DEFAULT CHARSET utf8mb4 建库",
    ),
    (
        "not allowed to connect",
        "这个账号不允许从本机连接：请在 MySQL 里给该账号开放本机访问权限",
    ),
    (
        "unknown mysql server host",
        "主机名解析失败：请填 IP（如 127.0.0.1）或确认主机名拼写正确",
    ),
    (
        "name or service not known",
        "主机名解析失败：请填 IP（如 127.0.0.1）或确认主机名拼写正确",
    ),
    (
        "nodename nor servname",
        "主机名解析失败：请填 IP（如 127.0.0.1）或确认主机名拼写正确",
    ),
    (
        "getaddrinfo",
        "主机名解析失败：请填 IP（如 127.0.0.1）或确认主机名拼写正确",
    ),
    (
        "ssl",
        "SSL/TLS 握手失败：确认 MySQL 的 SSL 设置与客户端一致（本机可先关闭强制 SSL 再试）",
    ),
    (
        "tls",
        "SSL/TLS 握手失败：确认 MySQL 的 SSL 设置与客户端一致（本机可先关闭强制 SSL 再试）",
    ),
    (
        "certificate verify failed",
        "SSL/TLS 证书校验失败：确认 MySQL 证书有效，或在本机场景改用不需要校验的方式连接",
    ),
    ("Can't connect", "连不上，确认 MySQL 已启动、端口正确"),
    ("Connection refused", "连不上，确认 MySQL 已启动、端口正确"),
    ("timed out", "连接超时，确认地址与端口可达"),
    ("timeout", "连接超时，确认地址与端口可达"),
    ("Too many connections", "MySQL 连接数已满：等一会儿再试，或调大 max_connections"),
)

# 兜底文案：绝不回传原文。pymysql 的异常几乎都带 `root@10.0.0.5:3306/suixinwenda` 这类细节，
# 直接贴到界面等于把主机名、库名与账号暴露给截图 / 日志，也说不出该改哪。
FALLBACK_HINT = "连接失败，原因未能识别：请检查主机、端口、账号密码与库名（详细原因见后端日志）"


def _friendly(message: str) -> str:
    text_ = message or ""
    lowered = text_.lower()
    for needle, hint in ERROR_HINTS:
        if needle.lower() in lowered:
            return hint
    # 原文只进 stderr（桌面端会连同失败一起吞掉，不会展示给用户）
    print(f"[storage_test] 未识别的连接错误：{text_.strip()[:500]}", file=sys.stderr)
    return FALLBACK_HINT


def _url(host: str, port: str, user: str, password: str, name: str) -> str:
    return (
        f"mysql+pymysql://{quote_plus(user)}:{quote_plus(password)}"
        f"@{host}:{port}/{name}?charset=utf8mb4"
    )


def main() -> None:
    host = os.environ.get("SUIXINWENDA_PROBE_HOST", "127.0.0.1")
    port = os.environ.get("SUIXINWENDA_PROBE_PORT", "3306")
    user = os.environ.get("SUIXINWENDA_PROBE_USER", "root")
    password = os.environ.get("SUIXINWENDA_PROBE_PASSWORD", "")
    name = os.environ.get("SUIXINWENDA_PROBE_NAME", "")
    ssl_ca = os.environ.get("SUIXINWENDA_PROBE_SSL_CA", "").strip()

    payload = {
        "ok": False,
        "version": "",
        "database": name,
        "empty": None,
        "rows": 0,
        "error": "",
        # 远程库 = 聊天记录会离开本机：界面上要据此给一句明确提示，而不是测通了就静默切换
        "remote": host not in LOCAL_HOSTS,
    }
    # 空密码在连接前就判：等到 pymysql 报「Access denied (using password: NO)」再说，
    # 用户看到的会是一条「用户名或密码不对」，改半天也想不到是自己根本没填密码
    if not password.strip():
        payload["error"] = ERROR_HINTS[0][1]
        emit(payload)
        return
    connect_args = {"connect_timeout": 5}
    if ssl_ca:
        # 与 core.db_info.ssl_connect_args 同口径：有 CA 就用 TLS 并校验证书，
        # 不提供「跳过校验」的选项——那等于把中间人攻击的门开着
        if not os.path.isfile(ssl_ca):
            payload["error"] = "CA 证书文件不存在：请重新选择 .pem 文件，或清空该项后再试"
            emit(payload)
            return
        connect_args.update({"ssl_ca": ssl_ca, "ssl_verify_cert": True})
        # 与 core.db_info.ssl_connect_args 同口径：默认校验主机名，只有显式豁免才放宽
        if os.environ.get("SUIXINWENDA_PROBE_SSL_NO_VERIFY_IDENTITY", "").strip() == "1":
            payload["tls_identity"] = "skipped"
        else:
            connect_args["ssl_verify_identity"] = True
    engine = create_engine(
        _url(host, port, user, password, name),
        pool_pre_ping=True,
        connect_args=connect_args,
        pool_size=1,
        max_overflow=0,
    )
    try:
        with engine.connect() as conn:
            version = str(conn.execute(text("SELECT VERSION()")).scalar() or "")
            payload["version"] = version
            major = int(version.split(".", 1)[0]) if version[:1].isdigit() else 0
            if major < 8:
                payload["error"] = f"需要 MySQL 8.0 或更高（当前 {version or '未知'}）"
            else:
                tables = (
                    conn.execute(
                        text(
                            "SELECT COUNT(*) FROM information_schema.tables "
                            "WHERE table_schema = DATABASE()"
                        )
                    ).scalar()
                    or 0
                )
                # 目标库必须为空：跨存储复制只支持导入空库，这里先替界面判断好
                if tables == 0:
                    payload["empty"] = True
                else:
                    # 库非空不等于「是本项目的库」：没有 conversations 表时直接 COUNT 会抛异常，
                    # 结果被翻译成「连接失败」，用户会去反复改密码/端口
                    has_table = (
                        conn.execute(
                            text(
                                "SELECT COUNT(*) FROM information_schema.tables "
                                "WHERE table_schema = DATABASE() AND table_name = 'conversations'"
                            )
                        ).scalar()
                        or 0
                    )
                    if has_table:
                        rows = conn.execute(text("SELECT COUNT(*) FROM conversations")).scalar() or 0
                        payload["rows"] = int(rows)
                        payload["empty"] = int(rows) == 0
                    else:
                        payload["empty"] = True
                        payload["error"] = (
                            "目标库已连上，但里面没有随心问答的表；切换过去会从空库开始"
                        )
                payload["ok"] = True
    except Exception as error:  # noqa: BLE001  连接失败是正常分支，要把原因翻译成中文
        payload["error"] = _friendly(str(error))
        if payload["remote"] and any(
            key in payload["error"] for key in ("连不上", "超时", "主机名", "SSL")
        ):
            # 远程库连不上时，最常见的不是 MySQL 没起，而是安全组/防火墙没放行。
            # 不加这一句，用户会在本机反复重启 MySQL
            payload["error"] += "（远程库请确认目标安全组 / 防火墙已放行本机出口 IP）"
    finally:
        # 唯一允许建临时 engine 的地方：用完必须 dispose，绝不污染全局 engine
        engine.dispose()
    emit(payload)


if __name__ == "__main__":
    main()
