"""命令行工具包：不参与应用运行时，只给运维脚本与桌面端调用。

单独成包是为了 `uv run python -m tools.xxx` 能稳定导入 core：
pytest 的 pythonpath 与 uvicorn 的 cwd 都是 backend/，与这里一致。
"""
import json


def emit(payload: dict) -> None:
    """输出唯一一行 JSON，并用退出码表达成败（成功 0 / 失败 1）。

    桌面端只解析这行 JSON，但 CI、start.ps1 与用户自己写的脚本依赖退出码：
    以前失败也返回 0，等于「命令成功但什么都没做」，自动化里根本发现不了。
    用 SystemExit 而不是 sys.exit：两者等价，且不用额外导入。
    """
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(0 if payload.get("ok") else 1)
