"""模型验证接口的节流容量上限：id 来自请求体且匿名可达，字典必须有界。

只测「上限是否真的挡住无界增长」与「过期项会被清掉」两件事；
verify 的真实上游调用由 test_ai_models.py 覆盖，这里一律命中「模型未配置」分支。
"""
import pytest
from fastapi.testclient import TestClient

from main import app
from routers import chat as chat_router

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_verify_track(monkeypatch):
    """_verify_last 是进程内共享字典，不清会让不同用例互相占用额度。

    时钟一并固定：`time.monotonic()` 的绝对值是「开机以来的秒数」，直接用它会让
    「字典满时拒绝新 id」这条用例在刚开机的机器（CI runner 就是）上永远进不到目标分支，
    表现为本地/CI 结果不一致。这里换成固定值，用例只依赖相对间隔。
    """
    monkeypatch.setattr(chat_router, "_verify_last", {})
    monkeypatch.setattr(chat_router, "_verify_monotonic", lambda: 100_000.0)


def _verify(model_id: str) -> dict:
    resp = client.post("/api/v1/models/verify", json={"id": model_id})
    assert resp.status_code == 200
    return resp.json()


def test_verify_track_rejects_new_ids_when_full(monkeypatch):
    """字典满且没有过期项时拒绝新 id：绝不让它随请求无界增长。"""
    monkeypatch.setattr(chat_router, "_VERIFY_TRACK_MAX", 2)
    monkeypatch.setattr(chat_router, "_VERIFY_MIN_INTERVAL_SECONDS", 3600.0)

    _verify("m-a")
    _verify("m-b")
    blocked = _verify("m-c")

    assert blocked["ok"] is False
    assert "频繁" in blocked["error"]
    assert len(chat_router._verify_last) == 2


def test_verify_track_prunes_expired_ids_before_rejecting(monkeypatch):
    """满字典里若有已过期的 id，应先清掉它们再放行新 id（而不是一律拒绝）。"""
    monkeypatch.setattr(chat_router, "_VERIFY_TRACK_MAX", 2)
    # 间隔设为 0：上一次记录立刻过期，于是「清过期项」这条分支必须生效
    monkeypatch.setattr(chat_router, "_VERIFY_MIN_INTERVAL_SECONDS", 0.0)

    _verify("m-a")
    _verify("m-b")
    allowed = _verify("m-c")

    # 没配置 Key 的模型会走到「这个模型还没有配置 Key」，关键是没被容量闸拦下
    assert "频繁" not in (allowed.get("error") or "")
    assert len(chat_router._verify_last) == 1
