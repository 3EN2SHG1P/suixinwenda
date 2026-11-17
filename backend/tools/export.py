"""把当前库导出成可搬移的 JSONL + manifest。附件不参与：它们的路径与库后端无关。

为什么是 JSONL 而不是 SQL 语句：逐行可读、可 diff、可流式写，且不依赖目标库的 SQL 方言；
将来真要导入时，一行一条记录最省事。
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

from sqlalchemy import inspect, text
from sqlmodel import SQLModel

from core import db_info
from core.database import engine
from tools import emit

# 导出顺序 = 导入顺序：先 users 再 conversations，外键（如果有）才不会挡路
TABLES = ("users", "conversations", "chat_messages", "chat_attachments", "chat_summaries")


def _ensure_tables() -> None:
    """工具子进程不跑 main.py 的 lifespan：连到一个还没有表的空库（刚切到 SQLite
    的典型状态）时，SELECT 会报 no such table。create_all 幂等，已有表不动；
    空库导出的就是一份空的合法数据，这比报错更符合「导出当前库」的语义。"""
    SQLModel.metadata.create_all(engine)


def _dump_table(conn, table: str, target: Path) -> dict:
    hasher = hashlib.sha256()
    rows = 0
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        # 按第一列（各表的主键）排序：同样的数据导两次，文件字节一致，便于比对
        result = conn.execution_options(stream_results=True).execute(
            text(f"SELECT * FROM {table} ORDER BY 1")
        )
        for row in result:
            line = json.dumps(dict(row._mapping), ensure_ascii=False) + "\n"
            handle.write(line)
            hasher.update(line.encode("utf-8"))
            rows += 1
    return {"rows": rows, "sha256": hasher.hexdigest()}


def export_to(out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _ensure_tables()
    tables = {}
    with engine.connect() as conn:
        # 同一个读事务里导完 5 张表：不开事务时导出期间的新写入会让「消息比会话新」，
        # 包内部自相矛盾；MySQL 借此拿到 REPEATABLE READ 快照（与 core/backup.py 同口径）
        with conn.begin():
            for table in TABLES:
                tables[table] = _dump_table(conn, table, out_dir / f"{table}.jsonl")
    # 库里可能还有不再使用的历史表（老版本留下的 LangGraph checkpoint 四表）。
    # 把它们写进 manifest：否则用户会疑惑「MySQL 有 9 张表，导出只有 5 个文件」。
    present = set(inspect(engine).get_table_names())
    manifest = {
        "exported_at": int(time.time()),
        "backend": db_info.db_backend(),
        "location": db_info.describe()["location"],
        "tables": tables,
        "skipped_tables": sorted(present - set(TABLES)),
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="导出当前库为 JSONL + manifest")
    parser.add_argument("--out", required=True, help="输出目录")
    args = parser.parse_args()
    try:
        manifest = export_to(Path(args.out))
        payload = {
            "ok": True,
            "backend": manifest["backend"],
            "tables": {name: item["rows"] for name, item in manifest["tables"].items()},
        }
    except Exception as error:  # noqa: BLE001  CLI 要把失败原因原样告诉用户
        payload = {"ok": False, "error": str(error)}
    emit(payload)


if __name__ == "__main__":
    main()
