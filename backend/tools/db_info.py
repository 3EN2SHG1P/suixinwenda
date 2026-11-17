"""打印当前存储配置与连通性：一行 JSON，供 start.ps1、桌面端与排查时直接解析。

只输出一行：调用方用 ConvertFrom-Json / JSON.parse 吃，多余的调试输出会让他们解析失败。
位置字段不含绝对路径。

probe 走延迟导入：core.database 在 import 期就要建 engine，配置缺项时会抛异常。
诊断工具本身不能因为「配置错」而只吐一段栈——那样用户手上什么信息都没有。

错误文本统一用 storage_test 的中文口径：那里已经覆盖了「连不上 / 密码不对 / 库不存在 /
SSL 握手失败」等分支，两处各写一份必然会漂移。
"""
from core import db_info
from tools import emit
from tools.storage_test import _friendly


def main() -> None:
    payload = {**db_info.describe(), "ok": False, "error": ""}
    try:
        # 先过配置校验：这两个是桌面端「切换存储」失败时最常见的两类原因，
        # 提前拦下能给出可照做的中文，而不是让 engine 抛一句 FileNotFoundError
        db_info.validate_remote()
        db_info.validate_ssl()
        from core.database import probe_detail
    except RuntimeError as error:
        payload["error"] = str(error)
    else:
        ok, detail = probe_detail()
        payload["ok"] = ok
        if not ok:
            payload["error"] = _friendly(detail) if detail else "连接失败：请检查端口与库名"
    emit(payload)


if __name__ == "__main__":
    main()
