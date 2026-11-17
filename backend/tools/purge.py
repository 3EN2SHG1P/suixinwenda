"""一键清除当前存储的全部会话数据（账号保留）。

清的是「当前后端指向的那个库」：conversations / chat_messages / chat_summaries /
chat_attachments 四张表，以及当前后端的附件目录。

为什么做成独立工具而不是接口：它不可逆、也不该被任何请求路径触发，
只能由桌面端在用户二次确认后起一个独立进程执行。
不给 --yes 时只打印统计（dry-run），避免手滑清库。
"""
import argparse

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlmodel import Session, SQLModel

from tools import emit

from core import db_info
from core.attachments import upload_dir
from core.database import engine
from models import ChatAttachment, ChatMessage, ChatSummary, Conversation

TABLES = (
    ("conversations", Conversation),
    ("messages", ChatMessage),
    ("summaries", ChatSummary),
    ("attachments", ChatAttachment),
)


def _ensure_tables() -> None:
    """工具子进程不跑 main.py 的 lifespan，连到的库可能一个表都没有。

    典型场景：刚从 MySQL 切到 SQLite，目标位置只有个空文件（甚至被备份工具
    的连接顺手建了出来）。create_all 幂等，已有表原样不动。
    """
    SQLModel.metadata.create_all(engine)


def counts() -> dict:
    _ensure_tables()
    with Session(engine) as session:
        # 用 execute().scalar_one()：SQLModel 的 exec() 对这种单列聚合返回 Row，直接 int() 会报错
        return {
            name: int(session.execute(select(func.count()).select_from(model)).scalar_one() or 0)
            for name, model in TABLES
        }


def purge_files() -> int:
    """删当前后端的附件文件（只删文件，不动目录本身）。"""
    root = upload_dir()
    if not root.exists():
        return 0
    removed = 0
    for item in root.rglob("*"):
        if item.is_file():
            try:
                item.unlink()
                removed += 1
            except OSError:
                # 单个文件删不掉不影响整体（可能是别的进程占着），下次启动的孤儿清理会兜住
                continue
    return removed


def purge_all(*, keep_files: bool = False) -> dict:
    """清空业务表。

    keep_files=True 给恢复用：恢复会先把备份里的附件落到目标目录，再清库；
    这时如果连附件文件一起删，刚写进去的那批也会被抹掉。
    残留的旧文件没有库引用，下次启动的孤儿清理会按 7 天规则回收。
    """
    before = counts()
    # 顺序无关（这几张表之间没有外键），但先把子表清掉更符合直觉
    with Session(engine) as session:
        for _, model in reversed(TABLES):
            session.execute(sa_delete(model))
        session.commit()
    return {
        "backend": db_info.db_backend(),
        "location": db_info.describe()["location"],
        "deleted": before,
        "files": 0 if keep_files else purge_files(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="清除当前存储的全部会话数据")
    parser.add_argument("--yes", action="store_true", help="真正执行（不加只做统计）")
    args = parser.parse_args()

    try:
        if not args.yes:
            # dry-run 是成功路径：ok:false 会让调用方把「只做统计」当成失败
            emit({"ok": True, "dry_run": True, "counts": counts()})
            return
        emit({"ok": True, **purge_all()})
    except Exception as error:  # noqa: BLE001  CLI 要把失败原因原样告诉用户
        emit({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
