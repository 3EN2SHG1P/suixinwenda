"""用户表 users。"""
from sqlalchemy import BigInteger
from sqlmodel import Field, SQLModel

from models.base import table_args


class User(SQLModel, table=True):
    """用户：username 为自取账号（3-50 位，中文/字母/数字/_ . @ + -），password 存 PBKDF2 摘要。

    username 不要求是手机号或邮箱：本机账号不做归属验证，历史数据里的手机号/邮箱仍按原字符串登录。
    """

    __tablename__ = "users"
    __table_args__ = table_args()

    id: int | None = Field(default=None, primary_key=True)
    username: str = Field(max_length=50, unique=True)
    password: str = Field(max_length=255)  # PBKDF2 摘要，禁存明文
    nickname: str = Field(default="", max_length=50)
    avatar: str = Field(default="", max_length=255)
    status: int = Field(default=1)
    add_time: int = Field(default=0, sa_type=BigInteger)
