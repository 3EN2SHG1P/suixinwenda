"""聊天记录表 chat_messages。"""
from sqlalchemy import BigInteger, Index, Text
from sqlmodel import Field, SQLModel

from models.base import table_args


class ChatMessage(SQLModel, table=True):
    """一条消息：role = user / assistant；content 用 TEXT 承载长回复。

    superseded=1 表示这条 assistant 回复已被「重新生成」覆盖（内容留在库里便于追溯，
    但历史接口不再返回，避免刷新后出现两组重复问答）。
    """

    __tablename__ = "chat_messages"
    # superseded 索引原来只靠 MySQL 的 _ensure_indexes 补，模型里没有：
    # 新建的 SQLite 库就会缺这条索引，启动时的历史修复每次都全表扫聊天记录
    __table_args__ = table_args(
        Index("ix_chat_messages_superseded", "superseded"),
        # 热路径全是「某会话 + 未作废 + 按 id 倒序取最近 N 条」（上下文/历史分页）：
        # 单列 conversation_id 索引仍要把该会话全部行取出来再排序，MySQL 上还会 filesort
        Index("ix_chat_messages_conv_active_id", "conversation_id", "superseded", "id"),
        # 取「本会话最后一条 user / assistant」与历史修复按角色过滤走这条
        Index("ix_chat_messages_conv_role_id", "conversation_id", "role", "id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    conversation_id: int = Field(index=True)
    role: str = Field(max_length=20)
    content: str = Field(sa_type=Text)
    # 用户真正打的字（不含 `[上传文件]` 前缀与抽取正文）：上下文重建只认它；
    # 老数据为 NULL，运行时兜底到 content 剥掉开头文件标记后的正文
    question: str | None = Field(default=None, sa_type=Text)
    add_time: int = Field(default=0, sa_type=BigInteger)
    superseded: int = Field(default=0)
    # 产出这条回复的模型名（空 = 改造前的老数据）：切模型后历史里能分清是哪家答的
    model: str = Field(default="", max_length=64)
