"""测试连接（tools/storage_test.py）的错误翻译：每个分支都要给出「用户能照做」的中文。

为什么单独测这层：它唯一的产出就是一句给用户看的话。翻译漏了分支，界面就会出现
`(2003, "Can't connect to MySQL server on '10.0.0.9' ...")` 这种把主机名与账号
原样暴露给截图与日志的英文原文，而功能本身「看起来」是正常的。
"""
import json

import pytest

from tools import storage_test


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # 密码为空必须命中「using password: NO」这条更具体的分支，
        # 而不是被通用的 Access denied 抢走（否则用户会去改密码而不是填密码）
        (
            "(1045, \"Access denied for user 'root'@'localhost' (using password: NO)\")",
            "密码为空",
        ),
        (
            "(1045, \"Access denied for user 'root'@'localhost' (using password: YES)\")",
            "密码不对",
        ),
        (
            "(1045, \"Access denied for user 'app'@'%' (using password: YES)\")",
            "密码不对",
        ),
        ("(1049, \"Unknown database 'suixinwenda'\")", "库不存在"),
        (
            "(2005, \"Unknown MySQL server host 'db.internal' (-2)\")",
            "主机名解析失败",
        ),
        (
            "socket.gaierror: [Errno -2] Name or service not known",
            "主机名解析失败",
        ),
        ("(1130, \"Host '10.0.0.9' is not allowed to connect to this MySQL server\")", "不允许从本机连接"),
        ("(2003, \"Can't connect to MySQL server on '127.0.0.1'\")", "连不上"),
        ("ConnectionRefusedError: [WinError 10061] Connection refused", "连不上"),
        ("(2013, 'Lost connection to MySQL server ... (timed out)')", "连接超时"),
        ("(2026, 'SSL connection error: unknown error number')", "SSL/TLS 握手失败"),
        ("ssl.SSLCertVerificationError: certificate verify failed", "SSL/TLS"),
        ("(1040, 'Too many connections')", "连接数已满"),
    ],
)
def test_friendly_covers_each_branch(raw, expected):
    assert expected in storage_test._friendly(raw)


def test_friendly_never_returns_raw_message():
    """兜底分支不许回传原文：原文里通常带着 host / 库名 / 账号。"""
    raw = "(2003, \"Can't connect to MySQL server on 'db.internal' port 3306 user root db suixinwenda\")".replace(
        "Can't connect to MySQL server on ", "完全未知的错误 "
    )
    assert "db.internal" in raw, "构造的原文里确实有主机名"
    friendly = storage_test._friendly(raw)
    assert friendly == storage_test.FALLBACK_HINT
    assert "db.internal" not in friendly
    assert "3306" not in friendly


def test_main_with_empty_password_returns_chinese_without_connecting(monkeypatch, capsys):
    """空密码：连库之前就返回中文提示（不依赖 pymysql 的具体报错文案）。"""
    monkeypatch.setenv("SUIXINWENDA_PROBE_PASSWORD", "")
    # 失败必须以非零退出码结束：脚本/CI 靠它判断成败，桌面端才解析 JSON
    with pytest.raises(SystemExit) as excinfo:
        storage_test.main()
    assert excinfo.value.code == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["ok"] is False
    assert "密码为空" in payload["error"]


def test_main_with_unreachable_host_returns_chinese(monkeypatch, capsys):
    """错主机（这里用必然拒绝的 127.0.0.1:1 代）：输出必须是中文且不含原始英文细节。"""
    monkeypatch.setenv("SUIXINWENDA_PROBE_HOST", "127.0.0.1")
    monkeypatch.setenv("SUIXINWENDA_PROBE_PORT", "1")
    monkeypatch.setenv("SUIXINWENDA_PROBE_USER", "root")
    monkeypatch.setenv("SUIXINWENDA_PROBE_PASSWORD", "123456")
    monkeypatch.setenv("SUIXINWENDA_PROBE_NAME", "suixinwenda")

    with pytest.raises(SystemExit) as excinfo:
        storage_test.main()
    assert excinfo.value.code == 1

    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip())
    assert payload["ok"] is False
    # 端口 1 上不会有 MySQL：要么「连不上」，要么「超时」，两句都是中文可操作文案
    assert any(word in payload["error"] for word in ("连不上", "连接超时")), payload["error"]
    assert "Traceback" not in captured.out
    # 原文只允许出现在 stderr，绝不进给界面看的那一行动 JSON
    assert "OperationalError" not in captured.out
