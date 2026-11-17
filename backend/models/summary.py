"""会话摘要表 chat_summaries：一个会话一行，存一段摘要 + 覆盖进度。"""
from sqlalchemy import BigInteger, Text
from sqlmodel import Field, SQLModel

from models.base import table_args


class ChatSummary(SQLModel, table=True):
    """早前轮次的摘要：模型上下文 = 本表摘要 + 最近若干轮原文。

    covered_message_id 是覆盖上界（开区间）：id 小于它的消息都已经进摘要；
    covered_rounds 是已进摘要的完整轮数，必须与本列在同一条 SQL 里一起前进，
    否则「轮数」与「消息 id」会落在两个不同基准上，节流判断永久错位。
    """

    __tablename__ = "chat_summaries"
    __table_args__ = table_args()

    # 与 conversations.id 对齐，不建外键：会话删除时在同一事务里显式删除本行
    conversation_id: int = Field(primary_key=True)
    summary: str = Field(default="", sa_type=Text)
    # 覆盖上界（开区间）：id < 本值的消息均已进摘要；0 = 尚无摘要
    covered_message_id: int = Field(default=0)
    # 已进摘要的完整轮数，必须与本列同一条 SQL 前进
    covered_rounds: int = Field(default=0)
    add_time: int = Field(default=0, sa_type=BigInteger)
