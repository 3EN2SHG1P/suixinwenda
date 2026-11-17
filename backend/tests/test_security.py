"""认证基座单元测试：密码摘要格式/校验/老格式兼容 + 令牌异常分支。"""
import hashlib
import time

import pytest

from core import security


def test_hash_password_format():
    """摘要格式：pbkdf2_sha256$迭代$盐$派生值，且同一密码两次不同（随机盐）。"""
    hashed = security.hash_password("Passw0rd!123")
    parts = hashed.split("$")
    assert len(parts) == 4
    assert parts[0] == "pbkdf2_sha256"
    assert int(parts[1]) == security.HASH_ITERATIONS
    assert hashed != security.hash_password("Passw0rd!123")


def test_verify_password_ok_and_fail():
    """正向与错误路径：对的口令通过，错的口令/空摘要不通过。"""
    hashed = security.hash_password("Passw0rd!123")
    assert security.verify_password("Passw0rd!123", hashed) is True
    assert security.verify_password("wrongpass1", hashed) is False
    assert security.verify_password("Passw0rd!123", "") is False


def test_verify_password_legacy_sha256():
    """兼容：老的裸 sha256 摘要仍可校验，并标记为需要升级。"""
    legacy = hashlib.sha256("Passw0rd!123".encode("utf-8")).hexdigest()
    assert security.verify_password("Passw0rd!123", legacy) is True
    assert security.verify_password("wrongpass1", legacy) is False
    assert security.needs_rehash(legacy) is True


def test_verify_password_malformed():
    """畸形摘要不得抛异常（脏数据只当作校验失败）。"""
    huge_iterations = "pbkdf2_sha256$99999999999999999999$AA==$AA=="
    too_many_iterations = f"pbkdf2_sha256${security.HASH_ITERATIONS * 100}$AA==$AA=="
    for broken in (
        "pbkdf2_sha256$abc$x$y",
        "pbkdf2_sha256$0$AA==$AA==",
        huge_iterations,
        too_many_iterations,
        "md5$1$2$3",
        "abc",
    ):
        assert security.verify_password("Passw0rd!123", broken) is False


def test_token_roundtrip_and_rejects():
    """令牌：正常签发可解出 sub；篡改/残缺/过期一律 ValueError。"""
    token = security.create_access_token(7, "u@test.local")
    assert security.decode_token(token)["sub"] == 7
    assert security.decode_token(token)["username"] == "u@test.local"

    with pytest.raises(ValueError):
        security.decode_token("not-a-token")
    # 篡改签名段
    head, payload, _sign = token.split(".")
    with pytest.raises(ValueError):
        security.decode_token(f"{head}.{payload}.AAAA")

    # 过期令牌：用公共 encode_token 构造（不碰私有函数），验证 exp 分支确实生效
    expired = security.encode_token({"sub": 7, "exp": int(time.time()) - 10})
    with pytest.raises(ValueError):
        security.decode_token(expired)


def test_jwt_config_check_rejects_bad_values(monkeypatch):
    """启动时校验：密钥太短或有效期不是正整数，直接中文 RuntimeError。"""
    # 1. 密钥长度不足
    monkeypatch.setenv("JWT_SECRET", "short-secret")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        security.ensure_jwt_config()
    # 2. 密钥够长但有效期不是正整数
    monkeypatch.setenv("JWT_SECRET", "s" * 40)
    monkeypatch.setenv("JWT_EXPIRE_SECONDS", "0")
    with pytest.raises(RuntimeError, match="JWT_EXPIRE_SECONDS"):
        security.ensure_jwt_config()
    monkeypatch.setenv("JWT_EXPIRE_SECONDS", "abc")
    with pytest.raises(RuntimeError, match="JWT_EXPIRE_SECONDS"):
        security.ensure_jwt_config()
    # 3. 都合规时安静通过
    monkeypatch.setenv("JWT_EXPIRE_SECONDS", "604800")
    assert security.ensure_jwt_config() is None
