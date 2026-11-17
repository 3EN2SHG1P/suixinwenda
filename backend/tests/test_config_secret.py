"""数据库密码的两种配置来源：明文优先、只有密文时给可操作中文。

为什么值得单独测：这条路径错一半的表现都是「后端起不来」，而真实原因藏在
「密文只有桌面端能解」这件事里；另外「密文能不能被明文覆盖」决定手动跑 uvicorn 还灵不灵。
"""
import pytest

from core import config


@pytest.fixture(autouse=True)
def _clean_password_env(monkeypatch):
    for key in ("DB_PASSWORD", "DB_PASSWORD_ENC"):
        monkeypatch.delenv(key, raising=False)
    yield


def test_plaintext_wins(monkeypatch):
    """两个都有时用明文：用户手动写的那份必须立刻生效（手动启动后端就走这条）。"""
    monkeypatch.setenv("DB_PASSWORD", "plain-pw")
    monkeypatch.setenv("DB_PASSWORD_ENC", "tok")
    assert config.require("DB_PASSWORD") == "plain-pw"


def test_encrypted_only_gives_actionable_error(monkeypatch):
    """只有密文（桌面端加密存的）：说明只有桌面端能解，并给出两条可照做的路。"""
    monkeypatch.setenv("DB_PASSWORD_ENC", "tok")
    with pytest.raises(RuntimeError) as excinfo:
        config.require("DB_PASSWORD")
    message = str(excinfo.value)
    assert "桌面端" in message
    assert "DB_PASSWORD_ENC" in message
    assert "明文" in message


def test_missing_both_reports_missing_key():
    with pytest.raises(RuntimeError, match="缺少配置项：DB_PASSWORD"):
        config.require("DB_PASSWORD")


def test_values_may_contain_hash(monkeypatch, tmp_path):
    """口令里的 `#` 必须原样保留：按 # 一刀切会把 `ab#12` 截成 `ab`，
    表现是连接被拒（Access denied），而用户完全看不出是解析器改了他的口令。"""
    import os

    path = tmp_path / ".env"
    path.write_text(
        "PW_A=ab#12\nPW_B=ab # 说明文字\nPW_C=\"x#y\"\n",
        encoding="utf-8",
    )
    for key in ("PW_A", "PW_B", "PW_C"):
        monkeypatch.delenv(key, raising=False)
    config.load_env(path)
    assert os.environ["PW_A"] == "ab#12"
    assert os.environ["PW_B"] == "ab"
    assert os.environ["PW_C"] == "x#y"
