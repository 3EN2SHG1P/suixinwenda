"""会话接口入参校验。"""
from pydantic import BaseModel, Field, field_validator

from core.history import CLAIM_MAX_IDS

# 手动改名的长度上限（入库字段 100，这里留余量并给中文提示）
MAX_TITLE_LENGTH = 60


class ClaimIn(BaseModel):
    """POST /conversations/claim 入参：待认领的匿名会话 id 列表。"""

    # 可变默认值必须用 default_factory，避免多个请求共享同一个 list
    # 长度上限直接取 core.history.CLAIM_MAX_IDS（唯一源），不要在 schema 里另写一个数字：
    # 校验阶段就该挡住超长列表，而不是等业务层再截断（那样等于先白跑一遍）
    conversation_ids: list[int] = Field(default_factory=list, max_length=CLAIM_MAX_IDS)

    @field_validator("conversation_ids")
    @classmethod
    def _check_ids(cls, value: list[int]) -> list[int]:
        """id 必须为正整数，重复自动去重（dict.fromkeys 保序且 O(n)，不用 list 的 in 判重）。"""
        for cid in value:
            if cid <= 0:
                raise ValueError("会话 id 必须为正整数")
        return list(dict.fromkeys(value))


class RenameIn(BaseModel):
    """PATCH /conversations/{id} 入参：新标题（去首尾空白后非空且不超长）。"""

    title: str = Field(default="")

    @field_validator("title")
    @classmethod
    def _check_title(cls, value: str) -> str:
        title = (value or "").strip()
        if not title:
            raise ValueError("标题不能为空")
        if len(title) > MAX_TITLE_LENGTH:
            raise ValueError(f"标题不能超过 {MAX_TITLE_LENGTH} 字")
        return title
