"""打包后的唯一入口：无参数 = 起后端服务；第一个参数是工具名 = 跑那个工具。

为什么需要它：PyInstaller 只能产出一个可执行文件，而桌面端既要「托管启动后端」，
又要跑 `backup / export / purge / restore / storage_test / db_info` 这些一次性工具
（`desktop/src/tool-run.js` 与 `backend-manager.js` 约定的就是 `suixinwenda-backend.exe <工具名> ...`）。

工具用延迟导入：跑 `storage_test` 时不该顺带把 FastAPI / LangChain / 数据库引擎全套拉起来——
那会让「测试连接」从 1 秒变成 5 秒，也会让工具在依赖缺失时抛一堆无关错误。
"""
import importlib
import sys

# 与 desktop/src/tool-run.js 的 TOOL_NAMES 保持一致：两边对不上就是「打包后工具跑不起来」
TOOLS = ("backup", "export", "purge", "restore", "storage_test", "db_info", "migrate_uploads")

USAGE = f"""随心问答后端（打包版）
  直接运行      启动本地服务（端口由 BACKEND_PORT 决定，默认 8010）
  <工具> ...    运行一次性工具：{' / '.join(TOOLS)}
"""


def resolve_target(argv: list[str]) -> tuple[str, str]:
    """返回 (kind, name)：kind 只会是 server / tool / help。

    只认精确的工具名：带着奇怪参数（比如被 Windows 快捷方式塞进来的路径）时按「起服务」处理，
    不让一个多余参数把后端变成永远起不来的状态。
    """
    if len(argv) > 1:
        first = argv[1].strip()
        if first in ("-h", "--help"):
            return "help", ""
        if first in TOOLS:
            return "tool", first
    return "server", ""


def main() -> None:
    kind, name = resolve_target(sys.argv)
    if kind == "help":
        print(USAGE)
        return
    if kind == "tool":
        # 让工具自己的 argparse 看到「程序名 + 它自己的参数」：
        # 直接 pop 掉工具名，sys.argv[1:] 就与 `python -m tools.<name> ...` 完全一致
        sys.argv.pop(1)
        module = importlib.import_module(f"tools.{name}")
        module.main()
        return
    from run import main as run_main

    run_main()


if __name__ == "__main__":
    main()
