"""模型配置的运行时来源：桌面端写入的明文 JSON（每个模型自带 Key 与 Base URL）。

为什么走文件而不是环境变量：
- 环境变量有长度上限（Windows 约 32K），模型多了会超；
- 桌面端保存后要立刻生效，"写文件 + 重启后端"最直接；
- 没有这个文件时（用户手动跑 uvicorn）返回 None，调用方回退到 .env 的两模型逻辑，
  现有用法完全不受影响。

文件由桌面端生成、写在 userData/runtime 下，退出时删除；这里只负责读取与规范化，
不做任何写操作（后端写配置会和桌面端抢同一份文件）。
"""
import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

# 单个模型的字段上限：只用于防御性截断，正常配置远小于这些值
MAX_TEXT = 200
MAX_ID = 64


def models_file() -> Path | None:
    """运行时模型配置的路径；没配置返回 None（= 走 .env 回退）。"""
    raw = os.environ.get("SUIXINWENDA_MODELS_FILE", "").strip()
    return Path(raw) if raw else None


def _text(value, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def load_models() -> dict | None:
    """读取并规范化模型配置。

    返回 None 表示"没有可用的配置文件"（不存在 / 读不了 / 不是合法结构），
    调用方应当回退到 .env 逻辑；返回 dict 时即使 models 为空也算有效配置
    （用户把模型删光时，界面应显示"还没有可用模型"，而不是悄悄回退到旧模型）。
    """
    path = models_file()
    if path is None or not path.is_file():
        return None
    try:
        # utf-8-sig：用户手改这个文件时，Windows 记事本/PowerShell 常带 BOM，
        # 用 utf-8 读会直接 ValueError，然后静默回退到 .env，表现成「配了却不生效」
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        logger.warning("模型配置文件读取失败，已回退到 .env：%s", error)
        return None
    if not isinstance(data, dict):
        logger.warning("模型配置文件结构不对，已回退到 .env")
        return None

    raw_models = data.get("models")
    if not isinstance(raw_models, list):
        logger.warning("模型配置文件缺少 models 数组，已回退到 .env")
        return None

    models: list[dict] = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = _text(item.get("id"), MAX_ID)
        upstream = _text(item.get("model"), MAX_ID)
        base_url = _text(item.get("baseUrl"))
        api_key = str(item.get("apiKey") or "").strip()
        name = _text(item.get("name")) or upstream or model_id
        # 缺 Key / 缺模型 ID / 地址不是 http(s) 的条目直接跳过：
        # 让它们出现在注册表里只会在聊天时抛一个看不懂的上游错误
        if not (model_id and upstream and api_key):
            continue
        if not base_url.startswith(("http://", "https://")):
            continue
        models.append(
            {
                "id": model_id,
                "name": name,
                "provider": _text(item.get("provider"), 32) or "custom",
                "model": upstream,
                "baseUrl": base_url,
                "apiKey": api_key,
                "vision": bool(item.get("vision")),
                "reasoning": bool(item.get("reasoning")),
            }
        )

    default = _text(data.get("default"), MAX_ID)
    logger.info("模型配置：%d 个可用模型（默认 %s）", len(models), default or "未指定")
    return {"models": models, "default": default}
