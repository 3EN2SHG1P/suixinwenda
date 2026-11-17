"""认证基座：密码 PBKDF2 摘要 + 自实现 HS256 JWT（stdlib，无第三方依赖）。"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from core.config import require

# 密码摘要参数（唯一源 =「密码算法」）：每用户随机盐 + PBKDF2-HMAC-SHA256 迭代
HASH_PREFIX = "pbkdf2_sha256"
HASH_ITERATIONS = 600_000
HASH_SALT_BYTES = 16

# JWT 密钥最小长度：短密钥可被离线爆破后伪造任意用户的令牌
JWT_SECRET_MIN_LENGTH = 32

# 老库兼容：早期版本落库的裸 sha256 十六进制摘要长度（登录成功后由 core/user.py 自动升级）
_LEGACY_HEX_LEN = 64


def _b64url_encode(data: bytes) -> str:
    """URL 安全 Base64（去填充），JWT 规范要求。"""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    """还原填充后解码。"""
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _b64std_encode(data: bytes) -> str:
    """标准 Base64（密码摘要里的盐与派生值用它，避免 URL 字符集歧义）。"""
    return base64.b64encode(data).decode("ascii")


def _b64std_decode(data: str) -> bytes:
    """标准 Base64 解码；非法输入抛 ValueError。"""
    return base64.b64decode(data.encode("ascii"), validate=True)


def hash_password(password: str) -> str:
    """生成密码摘要：`pbkdf2_sha256$迭代次数$盐$派生值`，禁存明文。

    每次调用都用新的随机盐，因此同一密码两次调用的结果不同（这是正确的，不要拿结果做等值比较）。
    """
    salt = os.urandom(HASH_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, HASH_ITERATIONS)
    return f"{HASH_PREFIX}${HASH_ITERATIONS}${_b64std_encode(salt)}${_b64std_encode(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """校验密码；同时兼容老版本裸 sha256 摘要，便于平滑升级。"""
    if not stored:
        return False
    parts = stored.split("$")
    # 1. 老格式：单个 64 位十六进制摘要（历史数据，登录成功后自动升级为新格式）
    if len(parts) == 1:
        if len(stored) != _LEGACY_HEX_LEN:
            return False
        legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return hmac.compare_digest(stored, legacy)
    # 2. 新格式：pbkdf2_sha256$迭代$盐$派生值
    if len(parts) != 4 or parts[0] != HASH_PREFIX:
        return False
    try:
        iterations = int(parts[1])
        salt = _b64std_decode(parts[2])
        expected = _b64std_decode(parts[3])
    except (ValueError, TypeError):
        return False
    # 迭代数必须落在合理区间：≤0 直接判错；超过当前标准 10 倍视为脏数据，
    # 否则一条被改坏的记录就能让登录卡死几分钟（或被用来做 CPU 消耗攻击）
    if iterations <= 0 or iterations > HASH_ITERATIONS * 10:
        return False
    if not salt or not expected:
        return False
    try:
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    except (ValueError, TypeError, OverflowError):
        return False
    return hmac.compare_digest(digest, expected)


def needs_rehash(stored: str) -> bool:
    """判断摘要是否需要升级（老格式或迭代次数低于当前标准）。"""
    parts = (stored or "").split("$")
    if len(parts) != 4 or parts[0] != HASH_PREFIX:
        return True
    try:
        return int(parts[1]) < HASH_ITERATIONS
    except (ValueError, TypeError):
        return True


def ensure_jwt_config() -> None:
    """启动时校验 JWT 配置；不合规直接中文报错，避免「服务起得来、一登录 500」。"""
    secret = require("JWT_SECRET")
    if len(secret) < JWT_SECRET_MIN_LENGTH:
        raise RuntimeError(
            f"JWT_SECRET 长度不足 {JWT_SECRET_MIN_LENGTH} 位，请检查 backend/.env，"
            "并用 python -c \"import secrets;print(secrets.token_urlsafe(48))\" 重新生成"
        )
    expire = require("JWT_EXPIRE_SECONDS")
    if not expire.isdigit() or int(expire) <= 0:
        raise RuntimeError("JWT_EXPIRE_SECONDS 必须是正整数（秒），请检查 backend/.env")


def encode_token(payload: dict) -> str:
    """按当前签名规则编码任意 payload；测试构造过期/异常令牌走这里，不要碰私有函数。"""
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = (
        f"{_b64url_encode(json.dumps(header, separators=(',', ':')).encode('utf-8'))}"
        f".{_b64url_encode(json.dumps(payload, separators=(',', ':')).encode('utf-8'))}"
    )
    signature = hmac.new(
        require("JWT_SECRET").encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{signing_input}.{_b64url_encode(signature)}"


def create_access_token(user_id: int, username: str) -> str:
    """签发 HS256 JWT：header.payload.signature，exp 取 JWT_EXPIRE_SECONDS（默认 7 天）。"""
    now = int(time.time())
    payload = {
        "sub": user_id,
        "username": username,
        "iat": now,
        "exp": now + int(require("JWT_EXPIRE_SECONDS")),
        # jti：令牌唯一标识，供后续做吊销/黑名单时按 id 精确定位
        "jti": secrets.token_hex(8),
    }
    return encode_token(payload)


def decode_token(token: str) -> dict:
    """校验签名与过期并返回 payload；失败抛 ValueError（会话鉴权直接复用）。"""
    # 1. 拆三段，格式不对即拒
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("令牌格式错误")
    header_b64, payload_b64, signature_b64 = parts
    # 2. 重算签名比对（不信任 header 里的 alg，杜绝 alg=none 攻击）
    signing_input = f"{header_b64}.{payload_b64}"
    expected = hmac.new(
        require("JWT_SECRET").encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    try:
        actual = _b64url_decode(signature_b64)
    except ValueError:
        raise ValueError("令牌签名无效")
    if not hmac.compare_digest(expected, actual):
        raise ValueError("令牌签名无效")
    # 3. 校验过期
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, TypeError):
        raise ValueError("令牌格式错误")
    if not isinstance(payload, dict):
        raise ValueError("令牌格式错误")
    try:
        expired = int(payload.get("exp", 0)) < int(time.time())
    except (TypeError, ValueError):
        raise ValueError("令牌格式错误")
    if expired:
        raise ValueError("令牌已过期")
    return payload
