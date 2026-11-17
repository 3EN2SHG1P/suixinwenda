"""对话接口入参校验（各项上限的唯一源：本文件）。"""
from pydantic import BaseModel, field_validator

# 消息字数上限（唯一源 =『MAX_MESSAGE_LENGTH』；超限前端禁用发送、后端 422）
MAX_MESSAGE_LENGTH = 4000
# 模型名长度上限（唯一源 =『MAX_MODEL_NAME_LENGTH』）
MAX_MODEL_NAME_LENGTH = 50


def normalize_message(value: str) -> str:
    """统一的文字校验：去首尾空白 + 非空 + 不超上限，失败抛中文 ValueError。

    /chat 走 Pydantic 模型校验，/chat_upload 的表单字段复用本函数，两条路径规则只有一份。
    """
    text = (value or "").strip()
    if not text:
        raise ValueError("消息不能为空")
    if len(text) > MAX_MESSAGE_LENGTH:
        raise ValueError(f"消息长度不能超过 {MAX_MESSAGE_LENGTH} 字")
    return text


class ChatIn(BaseModel):
    """POST /chat 入参：message 必填；model / conversation_id 可选。

    regenerate=True 走「重新生成」：覆盖最后一条 assistant 而不是追加一对新问答。
    """

    message: str
    model: str | None = None
    conversation_id: int | None = None
    regenerate: bool = False

    @field_validator("message")
    @classmethod
    def _check_message(cls, value: str) -> str:
        """消息非空且不超上限，失败给中文提示。"""
        return normalize_message(value)

    @field_validator("model")
    @classmethod
    def _check_model(cls, value: str | None) -> str | None:
        """模型名长度兜底（防超长字符串进日志与错误文案）。"""
        if value is None:
            return None
        text = value.strip()
        if len(text) > MAX_MODEL_NAME_LENGTH:
            raise ValueError(f"模型名长度不能超过 {MAX_MODEL_NAME_LENGTH} 字")
        return text or None
