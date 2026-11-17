"""打包入口的分派规则。

为什么值得单独测：`suixinwenda-backend.exe` 一个文件要当两种东西用（服务 / 工具），
分派错一条的表现是「打包后点击备份没反应」或「双击图标起不来服务」，而本地开发
（uv run python -m tools.x）永远不会暴露出这个问题。
"""
import re
from pathlib import Path

import launcher

# 仓库里两份「工具名清单」：本文件与桌面端的命令拼装模块。
# 路径按本文件定位，不依赖 pytest 从哪个目录启动
_TOOL_RUN_JS = Path(__file__).resolve().parents[2] / "desktop" / "src" / "tool-run.js"


def test_tool_names_match_desktop_tool_run_list():
    """工具名必须与 desktop/src/tool-run.js 的 TOOL_NAMES 一致，否则打包后工具跑不起来。

    以前这里只断言一份写死的元组：名字看着对，实际两边早就漂了（Python 7 项 / JS 6 项），
    用例照样绿。现在直接读 JS 源文件里的数组，任何一边增删都会立刻失败。
    """
    source = _TOOL_RUN_JS.read_text(encoding="utf-8")
    match = re.search(r"const TOOL_NAMES = \[(.*?)\];", source, re.S)
    assert match, "tool-run.js 里找不到 TOOL_NAMES 数组"
    js_names = re.findall(r"'([^']+)'", match.group(1))
    assert js_names == list(launcher.TOOLS), (
        f"工具名不一致：backend/launcher.py={list(launcher.TOOLS)}，desktop/src/tool-run.js={js_names}"
    )


def test_no_args_starts_server():
    assert launcher.resolve_target(["suixinwenda-backend.exe"]) == ("server", "")


def test_known_tool_dispatches():
    for name in launcher.TOOLS:
        assert launcher.resolve_target(["suixinwenda-backend.exe", name]) == ("tool", name)


def test_help_flags():
    assert launcher.resolve_target(["suixinwenda-backend.exe", "--help"]) == ("help", "")
    assert launcher.resolve_target(["suixinwenda-backend.exe", "-h"]) == ("help", "")


def test_unknown_argument_falls_back_to_server():
    """被人为塞进一个奇怪参数（快捷方式 / 旧版脚本）时不能把后端变成永远起不来。"""
    assert launcher.resolve_target(["suixinwenda-backend.exe", "--weird"]) == ("server", "")
    assert launcher.resolve_target(["suixinwenda-backend.exe", "C:/some/path"] ) == ("server", "")


def test_tool_dispatch_pops_name_and_calls_main(monkeypatch):
    """分派后 sys.argv 必须与 `python -m tools.<name> ...` 完全一致（argparse 依赖它）。"""
    calls = []

    class FakeModule:
        @staticmethod
        def main():
            calls.append(list(launcher.sys.argv))

    monkeypatch.setattr(launcher.importlib, "import_module", lambda name: FakeModule)
    monkeypatch.setattr(launcher.sys, "argv", ["suixinwenda-backend.exe", "backup", "--prefix", "x"])

    launcher.main()

    assert calls == [["suixinwenda-backend.exe", "--prefix", "x"]]
