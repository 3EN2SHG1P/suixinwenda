"""导出工具测试：空库（连表都没有）也能导出一份合法的空数据。

导出与清除、恢复一样是「工具子进程」，不跑 main.py 的 lifespan；
刚切到 SQLite 的用户点导出时，目标位置往往只有个空文件。
"""
import pytest
from sqlalchemy import create_engine

from tools import export


@pytest.fixture
def isolated_engine(monkeypatch, tmp_path):
    probe = create_engine(f"sqlite:///{(tmp_path / 'export.db').as_posix()}")
    monkeypatch.setattr(export, "engine", probe)
    yield probe
    probe.dispose()


def test_export_on_fresh_sqlite_without_tables(isolated_engine, tmp_path):
    """无表的空库：导出成功、每张表 0 行，而不是 no such table: users。"""
    out = tmp_path / "out"

    manifest = export.export_to(out)

    assert set(manifest["tables"]) == set(export.TABLES)
    assert all(item["rows"] == 0 for item in manifest["tables"].values())
    assert (out / "manifest.json").exists()
    for table in export.TABLES:
        assert (out / f"{table}.jsonl").exists()
