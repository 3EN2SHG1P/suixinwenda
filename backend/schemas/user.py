"""账号接口入参校验：账号（用户名/手机号/邮箱）、密码 6-64 位、可选验证码。"""
import re

from pydantic import BaseModel, field_validator

from core.limits import NICKNAME_TEXT_MAX, USERNAME_MAX

# 账号规则（唯一源）：3-50 位，允许中文、字母、数字与 _ . @ + % -
# 两条约束都是为「老账号还能登录」服务，改动前先读：
#   1. 字符集必须是老规则的超集（老规则 = 11 位手机号 或 邮箱），少了 % 或 . 就会让历史账号登不进来；
#   2. 长度上限取 50 而不是更短：库里存在长邮箱，收紧同样等于封掉老用户。
# 长度上限来自 core.limits.USERNAME_MAX（业务层截断读同一个常量），正则也由它拼出来
USERNAME_MIN = 3
USERNAME_RE = re.compile(
    "^[A-Za-z0-9_.@+%\\-\u4e00-\u9fa5]{" + f"{USERNAME_MIN},{USERNAME_MAX}" + "}$"
)

# 昵称长度：上限来自 core.limits，这里只补一个下限
NICKNAME_MIN = 1


def _check_username(value: str) -> str:
    """账号格式校验，失败返回中文（422 detail 数组）。

    先归一化再校验：MySQL 的大小写不敏感排序规则与 SQLite 的 BINARY 语义不同，
    不统一就会「MySQL 认为已注册、SQLite 认为可以注册」，两库之间导数据直接撞唯一索引。
    """
    normalized = (value or "").strip().lower()
    if len(normalized) > USERNAME_MAX:
        raise ValueError(f"账号长度不能超过 {USERNAME_MAX} 位")
    if not USERNAME_RE.match(normalized):
        raise ValueError(
            f"账号须为 {USERNAME_MIN}-{USERNAME_MAX} 位，可用中文、字母、数字或 _ . @ + % -"
        )
    return normalized


def _check_password(value: str) -> str:
    """密码长度校验（注册与登录同一套）。"""
    if not 6 <= len(value) <= 64:
        raise ValueError("密码长度须为 6-64 位")
    return value


def _check_code(value: str) -> str:
    """验证码须为数字；注册已不强制验证码，空串直接放行。"""
    if not value:
        return ""
    if not value.isdigit():
        raise ValueError("验证码须为数字")
    return value


def _check_nickname(value: str) -> str:
    """昵称长度校验：允许中文，去掉首尾空白后再判长度。"""
    normalized = (value or "").strip()
    if not NICKNAME_MIN <= len(normalized) <= NICKNAME_TEXT_MAX:
        raise ValueError(f"昵称须为 {NICKNAME_MIN}-{NICKNAME_TEXT_MAX} 个字符")
    return normalized


class SendCodeIn(BaseModel):
    """POST /send_code 入参（演示/兼容保留，注册已不需要验证码）。"""

    username: str

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return _check_username(value)


class RegisterIn(BaseModel):
    """POST /register 入参：账号 + 密码即注册；昵称与验证码可选（验证码只为老客户端保留）。"""

    username: str
    password: str
    code: str = ""
    nickname: str = ""

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return _check_username(value)

    @field_validator("password")
    @classmethod
    def _password(cls, value: str) -> str:
        return _check_password(value)

    @field_validator("code")
    @classmethod
    def _code(cls, value: str) -> str:
        return _check_code(value)

    @field_validator("nickname")
    @classmethod
    def _nickname(cls, value: str) -> str:
        # 空串 = 不填，交给后端按账号推导默认昵称
        return _check_nickname(value) if (value or "").strip() else ""


class LoginIn(BaseModel):
    """POST /login 入参。"""

    username: str
    password: str

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return _check_username(value)

    @field_validator("password")
    @classmethod
    def _password(cls, value: str) -> str:
        return _check_password(value)


class LoginByCodeIn(BaseModel):
    """POST /login_by_code 入参（演示/兼容保留）。"""

    username: str
    code: str

    @field_validator("username")
    @classmethod
    def _username(cls, value: str) -> str:
        return _check_username(value)

    @field_validator("code")
    @classmethod
    def _code(cls, value: str) -> str:
        return _check_code(value)


class RenameIn(BaseModel):
    """PATCH /me 入参。"""

    nickname: str

    @field_validator("nickname")
    @classmethod
    def _nickname(cls, value: str) -> str:
        return _check_nickname(value)
