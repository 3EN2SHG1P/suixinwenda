"""账号接口测试：FastAPI TestClient，每接口正向 + 错误路径，数据自建自清。"""
import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from core.config import require
from core.database import engine
from core.security import hash_password
from main import app

client = TestClient(app)

# 本文件创建过的账号，测试结束统一清理，禁止依赖演示数据与固定自增 id
_created_usernames: list[str] = []


def _new_username() -> str:
    """生成随机邮箱账号并登记待清理。"""
    username = f"t{uuid.uuid4().hex[:12]}@test.local"
    _created_usernames.append(username)
    return username


@pytest.fixture(autouse=True)
def _cleanup_users():
    """每个用例结束后删除本文件创建的用户。"""
    yield
    if _created_usernames:
        with engine.begin() as conn:
            for username in list(_created_usernames):
                conn.execute(
                    text("DELETE FROM users WHERE username = :u"), {"u": username}
                )
        _created_usernames.clear()


def test_send_code_ok(monkeypatch):
    """正向：send_code 返回验证码与有效期（演示模式回显；码从 .env 读，不算硬编码）。"""
    monkeypatch.setenv("DEMO_CODE_MODE", "1")
    username = _new_username()
    resp = client.post("/api/v1/send_code", json={"username": username})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == require("MOCK_CODE")
    assert body["expires_in"] == int(require("CODE_EXPIRE_SECONDS"))
    assert body["username"] == username


def test_username_normalized_so_case_variants_are_one_account(monkeypatch):
    """大小写不同的同一邮箱是同一个账号。

    MySQL 的 utf8mb4_unicode_ci 本来不敏感、SQLite 默认 BINARY 敏感：
    不归一化的话，同一邮箱在 SQLite 上能注册两次，导到 MySQL 直接撞唯一索引。
    """
    monkeypatch.setenv("DEMO_CODE_MODE", "1")
    lower = _new_username()
    upper = lower.upper()
    code = require("MOCK_CODE")

    client.post("/api/v1/send_code", json={"username": lower})
    first = client.post(
        "/api/v1/register", json={"username": lower, "password": "abc123", "code": code}
    )
    assert first.status_code == 200

    client.post("/api/v1/send_code", json={"username": upper})
    second = client.post(
        "/api/v1/register", json={"username": upper, "password": "abc123", "code": code}
    )
    assert second.status_code == 409, "大写形式必须被识别为同一账号"


def test_send_code_bad_username():
    """错误路径：非法账号 422 且 detail 为中文数组。"""
    resp = client.post("/api/v1/send_code", json={"username": "no"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert isinstance(detail, list)
    assert "3-50 位" in detail[0]["msg"]


def test_register_and_login_ok():
    """正向：发码 → 注册 → 密码登录 → 令牌可解出该用户。"""
    from core.security import decode_token

    username = _new_username()
    password = "Passw0rd!123"
    client.post("/api/v1/send_code", json={"username": username})
    reg = client.post(
        "/api/v1/register",
        json={"username": username, "password": password, "code": require("MOCK_CODE")},
    )
    assert reg.status_code == 200
    # 注册直接返回令牌与 user：id 在 user 里，不再有顶层 id
    user_id = reg.json()["user"]["id"]
    login = client.post(
        "/api/v1/login", json={"username": username, "password": password}
    )
    assert login.status_code == 200
    body = login.json()
    assert body["token_type"] == "bearer"
    assert decode_token(body["access_token"])["sub"] == user_id


def test_register_wrong_code():
    """错误路径：验证码错误 400 + 中文 detail。"""
    username = _new_username()
    client.post("/api/v1/send_code", json={"username": username})
    resp = client.post(
        "/api/v1/register",
        json={"username": username, "password": "Passw0rd!123", "code": "0000"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "验证码错误"


def test_register_duplicate():
    """错误路径：重复注册 409「该账号已注册」（验证码一次性，第二次要重发）。"""
    username = _new_username()
    payload = {"username": username, "password": "Passw0rd!123", "code": require("MOCK_CODE")}
    client.post("/api/v1/send_code", json={"username": username})
    assert client.post("/api/v1/register", json=payload).status_code == 200
    client.post("/api/v1/send_code", json={"username": username})
    again = client.post("/api/v1/register", json=payload)
    assert again.status_code == 409
    assert again.json()["detail"] == "该账号已注册"


def test_code_is_one_time():
    """安全：同一验证码只能成功用一次（防「知道账号 = 拿到登录态」被反复利用）。"""
    username = _new_username()
    client.post("/api/v1/send_code", json={"username": username})
    first = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": require("MOCK_CODE")}
    )
    assert first.status_code == 200
    again = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": require("MOCK_CODE")}
    )
    assert again.status_code == 400
    # 用过即失效：再拿同一个码来登录必须先重新获取
    assert "获取" in again.json()["detail"]


def test_send_code_limit_rejects_new_user(monkeypatch):
    """安全：记录数到上限时拒绝新的发送请求，且不淘汰 TTL 内还没用的记录。"""
    from core import user as user_service

    monkeypatch.setattr(user_service, "_codes", {})
    monkeypatch.setattr(user_service, "_CODE_SENT_MAX", 1)
    first = client.post("/api/v1/send_code", json={"username": _new_username()})
    assert first.status_code == 200
    second = client.post("/api/v1/send_code", json={"username": _new_username()})
    assert second.status_code == 400
    assert "频繁" in second.json()["detail"]
    # 自己的记录仍在，可以刷新（不会被自己的上限挡住）
    again = client.post("/api/v1/send_code", json={"username": first.json()["username"]})
    assert again.status_code == 200


def test_code_requires_send_first():
    """错误路径：没点「获取验证码」直接提交，400 中文提示（不能凭固定码直接登录）。"""
    resp = client.post(
        "/api/v1/login_by_code", json={"username": _new_username(), "code": require("MOCK_CODE")}
    )
    assert resp.status_code == 400
    assert "请先获取验证码" in resp.json()["detail"]


def test_login_fail_unified_message():
    """错误路径：密码错与账号不存在统一 401 同一句中文。"""
    username = _new_username()
    password = "Passw0rd!123"
    client.post("/api/v1/send_code", json={"username": username})
    client.post(
        "/api/v1/register",
        json={"username": username, "password": password, "code": require("MOCK_CODE")},
    )
    wrong_pw = client.post(
        "/api/v1/login", json={"username": username, "password": "wrongpass1"}
    )
    missing_user = client.post(
        "/api/v1/login",
        json={"username": _new_username(), "password": password},
    )
    assert wrong_pw.status_code == 401
    assert missing_user.status_code == 401
    assert wrong_pw.json()["detail"] == missing_user.json()["detail"] == "用户名或密码错误"


def test_login_by_code_new_then_existing():
    """正向：验证码登录首次自动注册 is_new_user=true，再次登录 false。"""
    username = _new_username()
    client.post("/api/v1/send_code", json={"username": username})
    first = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": require("MOCK_CODE")}
    )
    assert first.status_code == 200
    assert first.json()["is_new_user"] is True
    client.post("/api/v1/send_code", json={"username": username})
    second = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": require("MOCK_CODE")}
    )
    assert second.status_code == 200
    assert second.json()["is_new_user"] is False


def test_password_stored_as_hash():
    """落库核对：密码存 PBKDF2 摘要（带盐），禁明文。"""
    from core.security import verify_password

    username = _new_username()
    password = "Passw0rd!123"
    client.post("/api/v1/send_code", json={"username": username})
    client.post(
        "/api/v1/register",
        json={"username": username, "password": password, "code": require("MOCK_CODE")},
    )
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT password, nickname, status FROM users WHERE username = :u"),
            {"u": username},
        ).fetchone()
    assert row[0] != password
    assert row[0].startswith("pbkdf2_sha256$")
    assert verify_password(password, row[0]) is True
    assert verify_password("wrongpass1", row[0]) is False
    # 同一密码两次摘要不同（每次随机盐），这条能防「退回无盐哈希」的回归
    assert hash_password(password) != hash_password(password)
    assert row[1] == username.split("@")[0]
    assert row[2] == 1


def test_legacy_sha256_login_upgrades_to_pbkdf2():
    """兼容：老库里的裸 sha256 摘要仍能登录，且登录成功后自动升级为 PBKDF2。"""
    import hashlib

    from core.security import verify_password

    username = _new_username()
    password = "Passw0rd!123"
    legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (username, password, nickname, avatar, status, add_time) "
                "VALUES (:u, :p, :n, '', 1, 0)"
            ),
            {"u": username, "p": legacy, "n": username.split("@")[0]},
        )
    resp = client.post("/api/v1/login", json={"username": username, "password": password})
    assert resp.status_code == 200
    with engine.connect() as conn:
        stored = conn.execute(
            text("SELECT password FROM users WHERE username = :u"), {"u": username}
        ).scalar()
    assert stored.startswith("pbkdf2_sha256$")
    assert verify_password(password, stored) is True


def test_send_code_cooldown_blocks_resend(monkeypatch):
    """安全：同一账号冷却期内不能重发（防顶掉别人的验证码 / 短信轰炸），文案告诉还要等几秒。"""
    from core import user as user_service

    monkeypatch.setattr(user_service, "_codes", {})
    monkeypatch.setattr(user_service, "CODE_COOLDOWN_SECONDS", 60)
    username = _new_username()
    assert client.post("/api/v1/send_code", json={"username": username}).status_code == 200
    again = client.post("/api/v1/send_code", json={"username": username})
    assert again.status_code == 400
    assert "秒后再试" in again.json()["detail"]
    # 别的账号不受影响
    assert client.post("/api/v1/send_code", json={"username": _new_username()}).status_code == 200


def test_code_is_bound_to_account(monkeypatch):
    """安全：A 账号的验证码不能拿来登录 B 账号（验证码按账号隔离）。"""
    # 关掉固定演示码走随机分支，否则两个账号拿到同一个码，隔离无从验证
    monkeypatch.setenv("DEMO_CODE_MODE", "1")
    monkeypatch.delenv("MOCK_CODE", raising=False)
    user_a = _new_username()
    user_b = _new_username()
    code_a = client.post("/api/v1/send_code", json={"username": user_a}).json()["code"]
    code_b = client.post("/api/v1/send_code", json={"username": user_b}).json()["code"]
    assert code_a != code_b, "两个账号的验证码不应相同"
    wrong = client.post("/api/v1/login_by_code", json={"username": user_b, "code": code_a})
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "验证码错误"
    assert client.post(
        "/api/v1/login_by_code", json={"username": user_b, "code": code_b}
    ).status_code == 200


def test_demo_mode_off_hides_code(monkeypatch):
    """安全：DEMO_CODE_MODE=0 时响应体不再回显验证码（公网部署必须这样配）。"""
    username = _new_username()
    monkeypatch.setenv("DEMO_CODE_MODE", "0")
    resp = client.post("/api/v1/send_code", json={"username": username})
    assert resp.status_code == 200
    assert "code" not in resp.json()
    # 关掉回显不等于码失效：用固定演示码仍能登录（码此时只进服务端日志）
    login = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": os.environ["MOCK_CODE"]}
    )
    assert login.status_code == 200


def test_login_locked_after_too_many_failures(monkeypatch):
    """安全：连续失败到上限即临时锁定，挡住在线撞库（『登录失败锁定』）。"""
    from core import user as user_service

    monkeypatch.setattr(user_service, "_login_fails", {})
    monkeypatch.setattr(user_service, "LOGIN_FAIL_MAX", 2)
    username = _new_username()
    for _ in range(user_service.LOGIN_FAIL_MAX):
        resp = client.post(
            "/api/v1/login", json={"username": username, "password": "wrongpass1"}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "用户名或密码错误"
    locked = client.post(
        "/api/v1/login", json={"username": username, "password": "wrongpass1"}
    )
    # 429 而不是 401：401 会让客户端以为「登录态失效」去清令牌，
    # 这里实际是「错太多次，等几分钟」，与验证码锁定同一口径
    assert locked.status_code == 429
    assert "分钟后再试" in locked.json()["detail"]


def test_code_locked_after_too_many_failures():
    """安全：验证码连错到上限即锁定，第 6 次直接 429（不是 400），挡住无限试码。"""
    from core import user as user_service

    username = _new_username()
    client.post("/api/v1/send_code", json={"username": username})
    payload = {"username": username, "password": "Passw0rd!123", "code": "000000"}
    for _ in range(user_service.CODE_FAIL_MAX):
        resp = client.post("/api/v1/register", json=payload)
        assert resp.status_code == 400
        assert resp.json()["detail"] == "验证码错误"
    locked = client.post("/api/v1/register", json=payload)
    assert locked.status_code == 429, "失败次数到上限后应给 429，别再回 400 让用户继续试"
    assert "次数过多" in locked.json()["detail"]


def test_code_invalidated_after_lock(monkeypatch):
    """锁定到达上限时该账号手里的码已被作废：锁定过去后再拿正确码也进不去。"""
    from core import user as user_service

    username = _new_username()
    client.post("/api/v1/send_code", json={"username": username})
    wrong = {"username": username, "password": "Passw0rd!123", "code": "000000"}
    for _ in range(user_service.CODE_FAIL_MAX):
        client.post("/api/v1/register", json=wrong)

    # 把到期时间拨到过去，模拟「5 分钟已过」：锁定解除，但码在第一次达到上限时就被删了
    monkeypatch.setattr(user_service, "_code_fails", {username: (user_service.CODE_FAIL_MAX, 0.0)})

    retry = client.post(
        "/api/v1/register",
        json={"username": username, "password": "Passw0rd!123", "code": require("MOCK_CODE")},
    )
    assert retry.status_code == 400
    assert retry.json()["detail"] == "请先获取验证码", "码必须已作废，不能靠锁定单独兜"


def test_disabled_user_cannot_login():
    """安全：status != 1 的账号不得登录（封禁要真的生效）。"""
    username = _new_username()
    password = "Passw0rd!123"
    client.post("/api/v1/send_code", json={"username": username})
    client.post(
        "/api/v1/register",
        json={"username": username, "password": password, "code": require("MOCK_CODE")},
    )
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET status = 0 WHERE username = :u"), {"u": username}
        )
    resp = client.post("/api/v1/login", json={"username": username, "password": password})
    assert resp.status_code == 401
    assert "禁用" in resp.json()["detail"]


def test_disabled_user_code_is_not_consumed():
    """禁用账号的验证码不能被吃掉：解禁后同一个码还得能登录。

    验证码是一次性资源，失败路径先消费再判状态的话，用户解禁后必须重新拿码。
    """
    username = _new_username()
    client.post("/api/v1/register", json={"username": username, "password": "Passw0rd!123"})
    with engine.begin() as conn:
        conn.execute(text("UPDATE users SET status = 0 WHERE username = :u"), {"u": username})

    client.post("/api/v1/send_code", json={"username": username})
    denied = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": require("MOCK_CODE")}
    )
    assert denied.status_code == 401
    assert "禁用" in denied.json()["detail"]

    with engine.begin() as conn:
        conn.execute(text("UPDATE users SET status = 1 WHERE username = :u"), {"u": username})
    ok = client.post(
        "/api/v1/login_by_code", json={"username": username, "code": require("MOCK_CODE")}
    )
    assert ok.status_code == 200, "禁用期间不该消费验证码"


def test_register_without_code_and_returns_token():
    """正向：注册不再需要验证码，响应直接带令牌与 user，令牌可立刻用于鉴权接口。"""
    username = _new_username()
    resp = client.post("/api/v1/register", json={"username": username, "password": "Passw0rd!123"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["username"] == username

    auth = {"Authorization": f"Bearer {body['access_token']}"}
    me = client.patch("/api/v1/me", json={"nickname": "新名字"}, headers=auth)
    assert me.status_code == 200
    assert me.json()["nickname"] == "新名字"
    assert me.json()["username"] == username


def test_register_chinese_username():
    """正向：不填手机号/邮箱也能注册；中文账号的默认昵称就是账号本身。"""
    username = f"小明{uuid.uuid4().hex[:4]}"
    _created_usernames.append(username)
    resp = client.post("/api/v1/register", json={"username": username, "password": "abc123"})
    assert resp.status_code == 200
    assert resp.json()["user"]["nickname"] == username.lower()
    # 账号归一化转小写不影响中文：大小写不同/带空白的同一账号只能注册一次
    again = client.post("/api/v1/register", json={"username": f" {username} ", "password": "abc123"})
    assert again.status_code == 409
    login = client.post("/api/v1/login", json={"username": username, "password": "abc123"})
    assert login.status_code == 200


def test_register_with_nickname():
    """正向：注册时可自选昵称，不填才按账号推导。"""
    username = _new_username()
    resp = client.post(
        "/api/v1/register",
        json={"username": username, "password": "abc123", "nickname": "阿随"},
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["nickname"] == "阿随"


def test_legacy_accounts_still_login():
    """兼容：老规则（11 位手机号 / 邮箱）的账号在新账号规则下必须仍能登录。"""
    password = "Passw0rd!123"
    digits = str(int(uuid.uuid4().int % 10**8)).zfill(8)
    names = [f"138{digits}", _new_username()]
    for name in names:
        _created_usernames.append(name)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (username, password, nickname, avatar, status, add_time) "
                    "VALUES (:u, :p, '', '', 1, 0)"
                ),
                {"u": name, "p": hash_password(password)},
            )
        resp = client.post("/api/v1/login", json={"username": name, "password": password})
        assert resp.status_code == 200, f"老账号 {name} 在新规则下登不进来"


def test_rename_requires_login():
    """安全：改昵称必须已登录，匿名请求一律 401。"""
    resp = client.patch("/api/v1/me", json={"nickname": "匿名"})
    assert resp.status_code == 401


def test_rename_nickname_length_limited():
    """错误路径：昵称超过 20 字直接 422，不写库。"""
    username = _new_username()
    reg = client.post("/api/v1/register", json={"username": username, "password": "abc123"})
    auth = {"Authorization": f"Bearer {reg.json()['access_token']}"}
    resp = client.patch("/api/v1/me", json={"nickname": "名" * 21}, headers=auth)
    assert resp.status_code == 422
