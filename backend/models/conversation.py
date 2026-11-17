"""会话表 conversations。"""
from sqlalchemy import BigInteger, Index
from sqlmodel import Field, SQLModel

from models.base import table_args


class Conversation(SQLModel, table=True):
    """会话：user_id 为空 = 匿名会话；列表按 update_time 倒序。"""

    __tablename__ = "conversations"
    # 列表查询固定是「按 user_id 过滤 + update_time 倒序」：复合索引才不需要 filesort
    __table_args__ = table_args(Index("ix_conversations_user_update", "user_id", "update_time"))

    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = Field(default=None, index=True)
    title: str = Field(default="", max_length=100)
    add_time: int = Field(default=0, sa_type=BigInteger)
    update_time: int = Field(default=0, sa_type=BigInteger)
