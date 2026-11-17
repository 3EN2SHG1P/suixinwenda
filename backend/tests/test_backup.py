"""备份白名单测试：包里只能有 5 张业务表，停用的 checkpoint 表必须被裁掉。

这条守的是备份体积与数据可信度：实测那 4 张死表占了 98% 的体积，
而且 bytes 列导出来是 `b'...'` 文本（静默损坏）。白名单漏一个就等于没修。
"""
import json
import sqlite3
import time
import zipfile
from pathlib import Path

import pytest

from core import backup


@pytest.fixture
def data_dir(monkeypatch, tmp_path):
    """把 DATA_DIR 与 UPLOAD_DIR 都指到临时目录：绝不读写开发者的真实库与附件。"""
    root = tmp_path / "data"
    monkeypatch.setenv("DATA_DIR", str(root))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("DB_BACKEND", "sqlite")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _seed_sqlite(path: Path, tables: tuple[str, ...]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        for table in tables:
            if table == "chat_summaries":
                conn.execute("CREATE TABLE chat_summaries (conversation_id INTEGER PRIMARY KEY, summary TEXT)")
            else:
                conn.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, note TEXT)")
            conn.execute(f"INSERT INTO {table} VALUES (1, 'x')")
        conn.commit()
    finally:
        conn.close()


def _business_tables():
    return list(backup.TABLES)


def test_backup_keeps_only_business_tables(data_dir):
    # 老库：业务表 + 4 张停用的 checkpoint 表
    _seed_sqlite(
        data_dir / "suixinwenda.db",
        (*_business_tables(), "checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations"),
    )
    target = data_dir / "out.zip"

    result = backup.create_backup(target)

    assert result["included_tables"] == list(backup.TABLES)
    assert result["skipped_tables"] == [
        "checkpoint_blobs",
        "checkpoint_migrations",
        "checkpoint_writes",
        "checkpoints",
    ]

    with zipfile.ZipFile(target) as bundle:
        manifest = json.loads(bundle.read("manifest.json").decode("utf-8"))
        snapshot = bundle.read("db/suixinwenda.db")
    assert manifest["included_tables"] == list(backup.TABLES)
    assert manifest["skipped_tables"] == result["skipped_tables"]
    assert manifest["restore_hint"]
    assert "tables" not in manifest, "备份侧不许用 tables 这个键（导出侧是另一种形状）"
    # 库身份进包：恢复时能看出这份包属于哪个 MySQL 库（本地/远程同名库很多）
    assert manifest["scope"] == "sqlite"
    assert manifest["attachment_root"] == "data/uploads/sqlite"

    # 快照里真的没有历史表了（只看 manifest 是不够的）
    probe = data_dir / "snapshot.db"
    probe.write_bytes(snapshot)
    conn = sqlite3.connect(probe)
    try:
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()
    assert names == set(backup.TABLES)


def test_backup_tolerates_missing_table(data_dir):
    """库里没建 chat_summaries 也要能备份：直接遍历白名单会 SHOW CREATE TABLE 报错。"""
    tables = tuple(name for name in _business_tables() if name != "chat_summaries")
    _seed_sqlite(data_dir / "suixinwenda.db", tables)

    result = backup.create_backup(data_dir / "out.zip")

    assert "chat_summaries" not in result["included_tables"]
    assert len(result["included_tables"]) == len(tables)
    assert "chat_summaries" in result["skipped_tables"], "缺表必须能在 skipped_tables 里看出来"


def test_timestamped_backup_before_auto_pool(data_dir):
    """定期自动备份：文件名带 before-auto 前缀，明细照常回传（界面要显示附件数）。"""
    sqlite_path = data_dir / "suixinwenda.db"
    _seed_sqlite(sqlite_path, ("conversations", "chat_messages"))

    target, detail = backup.create_timestamped_backup_with_detail("before-auto")

    assert target.parent == data_dir / "backups"
    assert target.name.startswith("before-auto-sqlite-"), target.name
    assert target.exists()
    assert detail["backend"] == "sqlite"
    assert "conversations" in detail["included_tables"]
    # 旧的单值接口仍然只回路径（结构升级那条路径依赖它）
    assert backup.create_timestamped_backup("before-auto").parent == data_dir / "backups"


def test_prune_backups_keeps_prefix_pools_separate(data_dir, monkeypatch):
    """before-upgrade 与 before-restore 各留各的：共用配额会挤掉回滚升级的包。"""
    root = data_dir / "backups"
    root.mkdir(parents=True, exist_ok=True)
    now = time.time()
    made = []
    for index in range(4):
        for prefix in ("before-upgrade", "before-restore"):
            path = root / f"{prefix}-sqlite-2026010{index}-000000.zip"
            path.write_bytes(b"x")
            # mtime 递增：prune 只按 mtime 判断新旧
            import os

            os.utime(path, (now + index * 60, now + index * 60))
            made.append(path)

    assert backup.prune_backups(keep=2, backend="sqlite", prefix="before-restore") == 2
    left = {path.name.split("-sqlite-")[0] for path in root.glob("*.zip")}
    remaining = sorted(path.name for path in root.glob("before-restore-*.zip"))
    assert len(remaining) == 2, "恢复前备份只留最近 2 份"
    assert len(list(root.glob("before-upgrade-*.zip"))) == 4, "升级前备份一份都不能少"
    assert left == {"before-upgrade", "before-restore"}
