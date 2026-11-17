"""被桌面端托管时的启动入口。

除起 uvicorn 外，还监听父进程存活，父进程没了必须自己退出，
否则崩溃 / 强杀场景会留下孤儿进程占着端口。

两条哨兵同时在跑，谁先发现父进程没了谁就让它退出：
Windows 上等 Electron 的进程句柄（强杀场景可靠），同时读 stdin EOF（正常关闭场景很快）。
只靠 stdin 不够：`uv` 是中间层，它也持有同一个管道写端，Electron 被杀后 uv 还活着
（它在等 python 退出），EOF 永远不来，于是留下孤儿。
只靠父进程句柄也不够：正常关闭时 Electron 会先关 stdin 再等我们退出，
等到它自己消失才动，等于白等满桌面端的优雅窗口再被 taskkill。
"""
import ipaddress
import os
import sys
import threading

import uvicorn

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8010
# 与 main.py 的 demo_login_exposed() 同一口径：这几个地址只有本机能访问
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
# WaitForSingleObject 的 INFINITE
_INFINITE = 0xFFFFFFFF
_SYNCHRONIZE = 0x00100000


def _watch_stdin(server: uvicorn.Server) -> None:
    """等 stdin 关闭（父进程消失）后让 uvicorn 优雅退出。"""
    # pythonw / 无控制台启动时 sys.stdin 可能是 None：没有哨兵也不能让线程带异常退出
    stream = getattr(sys.stdin, "buffer", None)
    if stream is None:
        return
    while True:
        chunk = stream.read(1)
        if not chunk:
            break
    server.should_exit = True


def _watch_parent_process(server: uvicorn.Server, pid: int) -> None:
    """Windows：等父进程句柄被 signaled（进程退出）——不依赖任何管道。"""
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(_SYNCHRONIZE, False, pid)
    if not handle:
        # 父进程已经不在了（刚被杀），立刻退出
        server.should_exit = True
        return
    try:
        kernel32.WaitForSingleObject(handle, _INFINITE)
        server.should_exit = True
    finally:
        kernel32.CloseHandle(handle)


def _start_watchdog(server: uvicorn.Server) -> None:
    """两条哨兵同时挂着，谁先发现父进程没了谁就让它退出。

    只挂父进程句柄不够：桌面端「正常关闭」是先关 stdin 再等进程退出，
    单一父进程哨兵要等到 Electron 自己消失才动，退出会白等满 STOP_GRACE_MS 再被 taskkill。
    只挂 stdin 也不够：Electron 被强杀时 uv 中间层还持有管道，EOF 永远不来（见文件头）。
    """
    parent_pid = os.environ.get("SUIXINWENDA_PARENT_PID", "").strip()
    if sys.platform == "win32" and parent_pid.isdigit():
        threading.Thread(
            target=_watch_parent_process, args=(server, int(parent_pid)), daemon=True
        ).start()
    # 终端里直接跑时 stdin 是 tty（永远阻塞，无害）；被重定向成 /dev/null 会立刻 EOF
    threading.Thread(target=_watch_stdin, args=(server,), daemon=True).start()


def _port() -> int:
    """读监听端口；非法值直接给中文报错，不要抛一个用户看不懂的 ValueError 栈。"""
    raw = os.environ.get("BACKEND_PORT", str(DEFAULT_PORT)).strip() or str(DEFAULT_PORT)
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(f"BACKEND_PORT={raw} 不是数字，请检查 backend/.env") from None
    if not 1 <= port <= 65535:
        raise SystemExit(f"BACKEND_PORT={port} 超出 1-65535，请检查 backend/.env")
    return port


def _host() -> str:
    """读监听地址。

    托管模式下必须锁死成回环：桌面端面向单人本机，一旦监听通配地址（0.0.0.0 / ::）
    就等于把聊天记录暴露到局域网，而用户双击图标时并没有做过这个决定。
    """
    raw = os.environ.get("BACKEND_HOST", "").strip() or DEFAULT_HOST
    if raw.lower() == "localhost":
        host = raw
    else:
        try:
            ipaddress.ip_address(raw)
        except ValueError:
            raise SystemExit(
                f"BACKEND_HOST={raw} 不是合法的 IP 地址或 localhost，请检查 backend/.env"
            ) from None
        host = raw
    if os.environ.get("SUIXINWENDA_MANAGED") == "1" and host.lower() not in _LOOPBACK_HOSTS:
        raise SystemExit(
            f"托管模式只允许监听本机回环（当前 BACKEND_HOST={host}）。"
            "要对外提供服务请手动运行 uvicorn，并先读 README 的隐私说明"
        )
    return host


def main() -> None:
    host = _host()
    port = _port()
    # 必须传 app 对象而不是 "main:app" 字符串：uvicorn 对字符串走的是 importlib 动态导入，
    # PyInstaller 静态分析看不到，打包后就是「后端进程一启动就退出」。
    # 反过来，`python -m` 与 uvicorn CLI 启动时仍然可以正常导入。
    from main import app

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        # log_config=None 必须传：uvicorn 默认的 dictConfig 会重置 root handler，
        # main.py 里 basicConfig 配好的应用日志（首字耗时、摘要刷新）会全部丢失
        log_config=None,
        # timeout_graceful_shutdown 必须传：should_exit 之后 uvicorn 会等现有连接结束，
        # SSE 长连接可能永远不退，不设就是「关不掉的进程」
        timeout_graceful_shutdown=3,
    )
    server = uvicorn.Server(config)
    # 只在托管模式起哨兵：终端里直接跑时不需要（也不该）跟着某个进程退出
    if os.environ.get("SUIXINWENDA_MANAGED") == "1":
        _start_watchdog(server)
    server.run()


if __name__ == "__main__":
    main()
