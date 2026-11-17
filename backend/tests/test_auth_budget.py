"""慢哈希全局预算与「验证码默认不回显」的回归用例。

为什么单独成文件：这两条都不是某个接口的业务行为，而是两条安全边界——
1. 换随机账号能不能绕开 per-account 失败锁定（预算闸就是为此存在）；
2. 出厂配置会不会把验证码回显给任何能访问本机端口的人。
散在接口用例里容易被后来的人当成「多余的限流」删掉，所以单独钉住。
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from core import user as user_service
from core.database import engine
from main import app

client = TestClient(app)

PASSWORD = "Passw0rd!123"

_created_usernames: list[str] = []


def _new_username() -> str:
    """随机邮箱账号（满足 3-50 位与字符集约束），登记待清理。"""
    username = f"b{uuid.uuid4().hex[:12]}@test.local"
    _created_usernames.append(username)
    return username


@pytest.fixture(autouse=True)
def _cleanup_users():
    """每个用例结束后删掉本文件创建的账号，避免污染其它用例的 users 计数。"""
    yield
    if _created_usernames:
        with engine.begin() as conn:
            for username in list(_created_usernames):
                conn.execute(text("DELETE FROM users WHERE username = :u"), {"u": username})
        _created_usernames.clear()


def test_send_code_hides_code_by_default(monkeypatch):
    """默认配置下验证码不回显：响应里没有 code 字段（只写服务端日志）。"""
    monkeypatch.delenv("DEMO_CODE_MODE", raising=False)
    resp = client.post("/api/v1/send_code", json={"username": _new_username()})
    assert resp.status_code == 200
    body = resp.json()
    assert "code" not in body
    assert body["expires_in"] > 0


def test_send_code_echoes_only_when_demo_mode_on(monkeypatch):
    """显式开演示模式才回显：这条同时守住「默认值」与「开关仍然有效」两个方向。"""
    monkeypatch.setenv("DEMO_CODE_MODE", "1")
    resp = client.post("/api/v1/send_code", json={"username": _new_username()})
    assert resp.status_code == 200
    assert "code" in resp.json()


def test_login_with_random_username_hits_global_budget(monkeypatch):
    """随机账号连续登录会被全局预算挡住：这是「换账号绕过 per-account 锁定」的闸。"""
    monkeypatch.setenv("AUTH_BUDGET_PER_MINUTE", "1")
    monkeypatch.setattr(user_service, "_hash_calls", [])

    first = client.post(
        "/api/v1/login", json={"username": _new_username(), "password": PASSWORD}
    )
    # 账号不存在与密码错统一 401（不向调用方区分账号是否存在）
    assert first.status_code == 401

    second = client.post(
        "/api/v1/login", json={"username": _new_username(), "password": PASSWORD}
    )
    assert second.status_code == 429
    assert "频繁" in second.json()["detail"]


def test_register_hits_global_budget(monkeypatch):
    """注册同样跑慢哈希，因此同样受预算约束（否则它就是另一条算力放大路径）。"""
    monkeypatch.setenv("AUTH_BUDGET_PER_MINUTE", "1")
    monkeypatch.setattr(user_service, "_hash_calls", [])

    first = client.post(
        "/api/v1/register", json={"username": _new_username(), "password": PASSWORD}
    )
    assert first.status_code == 200

    second = client.post(
        "/api/v1/register", json={"username": _new_username(), "password": PASSWORD}
    )
    assert second.status_code == 429


def test_budget_window_allows_same_account_after_success(monkeypatch):
    """预算足够时，正常注册 + 登录不受影响（防止限流把正常链路写死）。"""
    monkeypatch.setenv("AUTH_BUDGET_PER_MINUTE", "10")
    monkeypatch.setattr(user_service, "_hash_calls", [])
    username = _new_username()

    registered = client.post(
        "/api/v1/register", json={"username": username, "password": PASSWORD}
    )
    assert registered.status_code == 200

    logged = client.post("/api/v1/login", json={"username": username, "password": PASSWORD})
    assert logged.status_code == 200
    assert logged.json()["user"]["username"] == username
