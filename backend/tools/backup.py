"""命令行备份入口：把数据库快照与附件打成一个 zip。
真正的实现在 core/backup.py（结构升级前的自动备份也用同一份逻辑，
两处各写一遍迟早会漂开）。这里只负责参数解析与一行 JSON 输出。

两种用法：
- `--out <zip>`：手动备份，存到用户选的位置；
- `--prefix <前缀>`：自动备份，落到 DATA_DIR/backups/ 并只清理同前缀的旧包
  （桌面端的定期自动备份用 before-auto；升级前是 before-upgrade，恢复前是 before-restore）。
"""
import argparse
from pathlib import Path

from core.backup import create_backup, create_timestamped_backup_with_detail
from tools import emit


def _emit(payload: dict) -> None:
    # 统一出口：一行 JSON + 与 ok 一致的退出码（失败必须非零，脚本/CI 才看得见）
    emit(payload)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成随心问答一致性备份（zip）")
    parser.add_argument("--out", help="输出 zip 路径（手动备份）")
    parser.add_argument(
        "--prefix",
        help="自动备份前缀：写到 DATA_DIR/backups/，只保留同前缀同后端的最近几份",
    )
    args = parser.parse_args()
    if not args.out and not args.prefix:
        parser.error("需要 --out 或 --prefix 之一")

    try:
        if args.prefix:
            target, detail = create_timestamped_backup_with_detail(args.prefix)
            payload = {"ok": True, **detail, "path": str(target)}
        else:
            payload = {"ok": True, **create_backup(Path(args.out)), "path": str(Path(args.out))}
    except Exception as error:  # noqa: BLE001  CLI 要把失败原因原样告诉用户
        payload = {"ok": False, "error": str(error)}
    _emit(payload)


if __name__ == "__main__":
    main()
