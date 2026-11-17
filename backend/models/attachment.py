"""附件表 chat_attachments：一条用户消息可挂一个附件，存元数据与抽取正文。

口径：二进制存本机 `data/uploads`（`stored_path` 只存相对路径），本表不存 blob；
`text_excerpt` 与送模型的抽取文本同源，供前端「查看文档内容」直接读，不再二次解析。
"""
from sqlalchemy import BigInteger, Text
from sqlmodel import Field, SQLModel

from models.base import table_args


class ChatAttachment(SQLModel, table=True):
    """一个上传附件：kind = image / text；同名文件按 sha256 去重落盘。"""

    __tablename__ = "chat_attachments"
    __table_args__ = table_args()

    id: int | None = Field(default=None, primary_key=True)
    message_id: int = Field(index=True)
    conversation_id: int = Field(index=True)
    name: str = Field(max_length=255)
    mime: str = Field(max_length=120)
    size: int = Field(default=0, sa_type=BigInteger)
    kind: str = Field(max_length=20)
    sha256: str = Field(max_length=64, index=True)
    stored_path: str = Field(max_length=255)
    text_excerpt: str = Field(default="", sa_type=Text)
    truncated: int = Field(default=0)
    add_time: int = Field(default=0, sa_type=BigInteger)
