"""命令行工具入口的契约测试：**只输出一行 JSON** + 退出码表达成败。

这三个入口没有 HTTP 路由，平时只有桌面端「设置」与 `start.ps1` 会调用它们：
调用方直接解析那一行 JSON，形状一旦变了也没有任何报错，
表现成「设置里的转圈停不下来」或「启动脚本说连不上数据库」，从现象追不到根因。
所以这里盯的是三件容易被顺手改坏的事：

1. 输出必须是**一行**合法 JSON（多一行调试输出，调用方解析就失败）；
2. 失败必须**非零退出码**（以前失败也返回 0，自动化里等于「命令成功但什么都没做」）；
3. 失败原因必须是中文可照做的文案，不能把 pymysql / OSError 原文直接抛给用户。
"""
import json
import sys
from pathlib import Path

import pytest

import core.database
from tools import backup as backup_tool
from tools import db_info as db_info_tool
from tools import migrate_uploads


def _run(monkeypatch, module, *argv) -> int:
    """像命令行那样跑一次 main()，返回退出码。"""
    monkeypatch.setattr(sys, "argv", [module.__name__, *argv])
    with pytest.raises(SystemExit) as exit_info:
        module.main()
    return exit_info.value.code


def _payload(capsys) -> dict:
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1, f"必须只输出一行 JSON，实际 {len(lines)} 行：{lines}"
    return json.loads(lines[0])


# ---------- tools/backup.py ----------


def test_backup_without_target_is_a_usage_error(monkeypatch):
    """既没给 --out 也没给 --prefix：argparse 的用法错误用 2，别和「备份失败」的 1 混在一起。"""
    assert _run(monkeypatch, backup_tool) == 2


def test_backup_out_writes_a_real_zip(monkeypatch, tmp_path, capsys):
    """真跑一次手动备份：这是用户点「立即备份」时走的同一条路径。"""
    target = tmp_path / "manual.zip"

    code = _run(monkeypatch, backup_tool, "--out", str(target))

    payload = _payload(capsys)
    assert code == 0
    assert payload["ok"] is True
    assert payload["path"] == str(target)
    assert target.is_file(), "报告成功就必须真的落出一个 zip"
    assert payload["backend"] == "sqlite"
    assert payload["db"].startswith("db/"), "manifest 里的库条目要能被恢复端直接拼路径"


def test_backup_prefix_uses_timestamped_path(monkeypatch, tmp_path, capsys):
    """自动备份（前缀模式）要回传真实落点，桌面端靠它列产物。"""
    monkeypatch.setattr(
        backup_tool,
        "create_timestamped_backup_with_detail",
        lambda prefix: (tmp_path / f"{prefix}-20260101-120000.zip", {"db": "db/x.db", "files": 3}),
    )

    code = _run(monkeypatch, backup_tool, "--prefix", "before-auto")

    payload = _payload(capsys)
    assert code == 0
    assert payload["files"] == 3
    assert payload["path"].endswith("before-auto-20260101-120000.zip")


def test_backup_failure_exits_nonzero_with_reason(monkeypatch, tmp_path, capsys):
    def boom(_out):
        raise OSError("磁盘已满")

    monkeypatch.setattr(backup_tool, "create_backup", boom)

    code = _run(monkeypatch, backup_tool, "--out", str(tmp_path / "x.zip"))

    payload = _payload(capsys)
    assert code == 1, "失败必须非零退出码，否则自动化看不见"
    assert payload["ok"] is False
    assert "磁盘已满" in payload["error"]


# ---------- tools/db_info.py ----------


def test_db_info_reports_sqlite_without_absolute_path(monkeypatch, capsys):
    """真跑一次：SQLite 之下的描述必须能直接解析，且**不得回传绝对路径**。

    绝对路径会把系统用户名与目录结构带进日志、接口响应与用户截图。
    """
    code = _run(monkeypatch, db_info_tool)

    payload = _payload(capsys)
    assert code == 0, payload
    assert payload["ok"] is True
    assert payload["backend"] == "sqlite"
    assert payload["location"], "调用方靠它显示「当前存在哪个库」"
    assert not Path(payload["location"]).is_absolute(), f"位置字段泄露了绝对路径：{payload['location']}"
    assert payload["error"] == ""


def test_db_info_surfaces_config_error_before_probing(monkeypatch, capsys):
    """配置不合规时不能去连库：直接给中文，退出码非零。"""

    def reject():
        raise RuntimeError("DB_HOST 指向非本机地址，聊天记录会离开本机")

    monkeypatch.setattr(db_info_tool.db_info, "validate_remote", reject)

    code = _run(monkeypatch, db_info_tool)

    payload = _payload(capsys)
    assert code == 1
    assert payload["ok"] is False
    assert "离开本机" in payload["error"]


def test_db_info_translates_probe_failure(monkeypatch, capsys):
    """探测失败的原文要翻译成可照做的中文（与 storage_test 同一套口径）。"""
    monkeypatch.setattr(db_info_tool.db_info, "validate_remote", lambda: None)
    monkeypatch.setattr(db_info_tool.db_info, "validate_ssl", lambda: None)
    monkeypatch.setattr(
        core.database, "probe_detail", lambda: (False, "Access denied for user 'root'@'localhost'")
    )

    code = _run(monkeypatch, db_info_tool)

    payload = _payload(capsys)
    assert code == 1
    assert payload["ok"] is False
    assert payload["error"] == "用户名或密码不对"


def test_db_info_falls_back_when_detail_is_empty(monkeypatch, capsys):
    monkeypatch.setattr(db_info_tool.db_info, "validate_remote", lambda: None)
    monkeypatch.setattr(db_info_tool.db_info, "validate_ssl", lambda: None)
    monkeypatch.setattr(core.database, "probe_detail", lambda: (False, None))

    code = _run(monkeypatch, db_info_tool)

    payload = _payload(capsys)
    assert code == 1
    assert payload["error"] == "连接失败：请检查端口与库名"


# ---------- tools/migrate_uploads.py ----------


def test_migrate_reports_disconnected_database(monkeypatch, capsys):
    """连不上库时不许动文件：迁移期间读到的会是「文件刚被移走」的中间状态。"""
    monkeypatch.setattr(core.database, "probe", lambda: False)
    monkeypatch.setattr(
        migrate_uploads, "migrate_legacy_uploads", lambda: pytest.fail("连不上库时不得开始迁移")
    )

    code = _run(monkeypatch, migrate_uploads)

    payload = _payload(capsys)
    assert code == 1
    assert payload["ok"] is False
    assert "先确认应用已退出" in payload["error"]


def test_migrate_reports_counts_and_paths(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(core.database, "probe", lambda: True)
    monkeypatch.setattr(
        migrate_uploads,
        "migrate_legacy_uploads",
        lambda: {"moved": 2, "skipped": 1, "failed": 0},
    )
    monkeypatch.setattr(migrate_uploads, "legacy_upload_root", lambda: tmp_path / "old")
    monkeypatch.setattr(migrate_uploads, "upload_dir", lambda: tmp_path / "new")

    code = _run(monkeypatch, migrate_uploads)

    payload = _payload(capsys)
    assert code == 0
    assert payload["ok"] is True
    assert (payload["moved"], payload["skipped"], payload["failed"]) == (2, 1, 0)
    assert payload["from"].endswith("old") and payload["to"].endswith("new")


def test_migrate_marks_partial_failure_as_not_ok(monkeypatch, tmp_path, capsys):
    """有文件搬失败就不是成功：退出码跟着 ok 走，脚本才敢继续往下跑。"""
    monkeypatch.setattr(core.database, "probe", lambda: True)
    monkeypatch.setattr(
        migrate_uploads,
        "migrate_legacy_uploads",
        lambda: {"moved": 1, "skipped": 0, "failed": 1},
    )
    monkeypatch.setattr(migrate_uploads, "legacy_upload_root", lambda: tmp_path / "old")
    monkeypatch.setattr(migrate_uploads, "upload_dir", lambda: tmp_path / "new")

    code = _run(monkeypatch, migrate_uploads)

    payload = _payload(capsys)
    assert code == 1
    assert payload["ok"] is False
    assert payload["failed"] == 1


def test_migrate_reports_import_failure_of_database_config(monkeypatch, capsys):
    """core.database 在 import 期就要建 engine：配置半残时不能只吐一段栈。"""
    monkeypatch.delattr(core.database, "probe")

    code = _run(monkeypatch, migrate_uploads)

    payload = _payload(capsys)
    assert code == 1
    assert payload["ok"] is False
    assert payload["error"].startswith("读取数据库配置失败")
