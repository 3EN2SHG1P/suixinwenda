"""长度兜底测试：SQLite 忽略 VARCHAR(n)，只靠库约束会在导出时炸。"""
from core.limits import clip


def test_clip_truncates_to_limit():
    assert clip("a" * 10, 4) == "aaaa"


def test_clip_keeps_short_and_none():
    assert clip("abc", 10) == "abc"
    assert clip(None, 10) == ""
