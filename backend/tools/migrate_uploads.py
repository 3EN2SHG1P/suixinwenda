"""把旧版平铺的附件目录搬到「按后端分开」的新位置（应用启动时也会自动跑一次）。

单独留一个入口是为了排查：搬了多少、跳过多少、是否有失败，一次看全。
执行前请先退出应用——迁移期间还开着应用会读到「文件刚被移走」的中间状态。
"""
from core.attachments import legacy_upload_root, migrate_legacy_uploads, upload_dir
from tools import emit


def main() -> None:
    try:
        # 延迟导入：core.database 在 import 期就建 engine，配置半残时会抛栈，
        # 那样用户只看到一段 traceback，拿不到这句中文
        from core.database import probe
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "error": f"读取数据库配置失败：{error}"})
        return
    if not probe():
        emit({"ok": False, "error": "连不上数据库：先确认应用已退出且 .env 配置正确"})
        return
    result = migrate_legacy_uploads()
    payload = {
        "ok": result["failed"] == 0,
        "from": str(legacy_upload_root()),
        "to": str(upload_dir()),
        **result,
    }
    emit(payload)


if __name__ == "__main__":
    main()
