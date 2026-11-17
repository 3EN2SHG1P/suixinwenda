"""模型接入：配置创建模型；创建失败只跳过并打日志，服务绝不起不来。

两条来源，按优先级：
1. 桌面端写入的运行时配置（`SUIXINWENDA_MODELS_FILE`）：每个模型自带 Base URL 与 Key，
   用户在设置里增删改，选哪个模型就走哪个模型的凭据；
2. 没有该文件时（用户手动跑 uvicorn）回退到 .env 的两模型逻辑，保持现有用法不变。
"""
import logging
import os
import re

from core.config import require  # 导入即加载 backend/.env
from core.models_config import load_models

logger = logging.getLogger(__name__)

# langchain.chat_models 的 import 约 1 秒（会连带拉进整个 langchain 运行时）。
# 放在函数内延迟导入：`import main` 不再为它付启动时间，首次真正建模型时才加载。
# 代价是首次对话多约 1 秒，但那是后台线程/请求路径，不影响窗口启动。

# 1. 常量唯一源（回退模式：deepseek-flash / 0.7）
#    厂商地址可用 .env 的 DEEPSEEK_BASE_URL / QWEN_BASE_URL 覆盖，方便接自建代理与私有化部署
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "").strip() or "https://api.deepseek.com/v1"
QWEN_BASE_URL = os.environ.get("QWEN_BASE_URL", "").strip() or "https://dashscope.aliyuncs.com/compatible-mode/v1"
TEMPERATURE = 0.7
DEFAULT_MODEL = "deepseek-flash"
# 读超时 + 重试次数（唯一源）：
# 上游半开连接或限流不返回时，`model.stream()` 可能长时间一个 chunk 都不吐；而取消机制只在
# 「下一个 chunk 到来时」检查 cancel_event（routers/chat.py 的 _iter_sync_stream），没有 chunk
# 就永远发现不了客户端已断开 → 线程与 SSE 连接一起泄漏，用户点「停止」毫无反应。
# 这个超时兜的正是「连接活着但不吐字」，与「连不上」（由 SDK 自己的连接错误兜）是两回事。
# 重试只在「建流阶段」对 429/5xx/连接错误生效：流一旦开始吐字，SDK 不会重放，不会让前端收到重复 token。
MODEL_TIMEOUT_SECONDS = 60
MODEL_MAX_RETRIES = 2
# 模型配置文件的 Key 绝不允许出现在日志 / 接口响应里：错误文本先做一次清洗。
# 只认 sk- 前缀会漏掉别家：Google 的 AIza…、Groq 的 gsk_…、以及中转服务自己发的随机串，
# 因此再加一条「16 位以上连续高熵串」的兜底（宁可多打码，也不能把 Key 写进日志）
_SECRET_PATTERN = re.compile(
    r"(?:sk-|gsk_|AIza)[A-Za-z0-9_\-]{8,}|(?<![A-Za-z0-9])[A-Za-z0-9_\-]{32,}(?![A-Za-z0-9])"
)


def _create(model: str, api_key: str, base_url: str):
    """所有厂商都走 OpenAI 兼容协议：差异只在 base_url 与 model 名。"""
    from langchain.chat_models import init_chat_model  # 延迟导入，见文件头注释

    return init_chat_model(
        model,
        model_provider="openai",
        api_key=api_key,
        base_url=base_url,
        temperature=TEMPERATURE,
        timeout=MODEL_TIMEOUT_SECONDS,
        max_retries=MODEL_MAX_RETRIES,
    )


def _build_models() -> dict:
    """回退模式：按 .env 的两把 Key 建注册表（Key 缺失或创建失败只跳过该模型）。"""
    registry: dict = {}
    deepseek_key = ""
    try:
        deepseek_key = require("DEEPSEEK_API_KEY")
        registry["deepseek-flash"] = _create("deepseek-flash", deepseek_key, DEEPSEEK_BASE_URL)
        _MODEL_KEYS["deepseek-flash"] = deepseek_key
    except Exception as exc:  # noqa: BLE001  绝不能让服务起不来
        # 统一走 _friendly_error：上游 SDK 的异常文本常带 Key 片段，原样进日志等于把 Key 写盘
        logger.warning("模型 deepseek-flash 不可用，已跳过：%s", _friendly_error(str(exc), deepseek_key))
    qwen_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    try:
        if qwen_key:
            registry["qwen-flash"] = _create("qwen-flash", qwen_key, QWEN_BASE_URL)
            _MODEL_KEYS["qwen-flash"] = qwen_key
    except Exception as exc:  # noqa: BLE001
        logger.warning("模型 qwen-flash 不可用，已跳过：%s", _friendly_error(str(exc), qwen_key))
    return registry


def _build_from_config(config: dict) -> tuple[dict, dict, str]:
    """按桌面端配置建注册表：返回 (注册表, 每个模型的展示信息, 默认模型)。"""
    registry: dict = {}
    meta: dict = {}
    for item in config.get("models", []):
        api_key = str(item.get("apiKey") or "")
        try:
            registry[item["id"]] = _create(item["model"], item["apiKey"], item["baseUrl"])
            _MODEL_KEYS[item["id"]] = api_key
            meta[item["id"]] = {
                "label": item["name"],
                "provider": item["provider"],
                "model": item["model"],
                "vision": item["vision"],
                "reasoning": item["reasoning"],
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "模型 %s 创建失败，已跳过：%s", item.get("id"), _friendly_error(str(exc), api_key)
            )
    wanted = str(config.get("default") or "")
    default = wanted if wanted in registry else next(iter(registry), "")
    return registry, meta, default


def _env_meta() -> dict:
    """回退模式的展示信息：与 MODEL_CAPABILITIES 同源，避免两处不一致。"""
    return {
        name: {
            "label": "DeepSeek" if name == "deepseek-flash" else "通义千问",
            "provider": "deepseek" if name == "deepseek-flash" else "qwen",
            "model": name,
            "vision": bool(caps.get("vision")),
            "reasoning": bool(caps.get("reasoning")),
        }
        for name, caps in MODEL_CAPABILITIES.items()
    }


# 模型能力表（回退模式的唯一源）：加模型时只改这里，前端零改动。
# vision = 这条链路能不能收图；reasoning = 会不会返回思维链。
MODEL_CAPABILITIES = {
    "deepseek-flash": {"vision": True, "reasoning": False, "speed": "fast"},
    "qwen-flash": {"vision": True, "reasoning": False, "speed": "fast"},
}

# 模块级名字保持不变（外部按 ai.MODELS / ai.MODEL_META 访问），第一次真正需要时才填充：
# 建注册表会 import langchain 并逐个建客户端，放在 import 期等于让每个进程都白付一次启动成本。
MODELS: dict = {}
MODEL_META: dict = {}
_DEFAULT = DEFAULT_MODEL
# 识别「被测试 monkeypatch 换成了另一个 dict」：那种情况说明调用方已经自行注入注册表，
# 绝不能再拿真实配置文件覆盖它（否则用例会读到 .env 里的 Key，行为随机器变化）
_INITIAL_MODELS = MODELS
_LOADED = False
# 注册表键 → 该模型的 API Key：只用于「异常文本里精确抹掉这把 Key」。
# 不进任何接口响应，也不进日志；verify_model 拿不到客户端对象里的 Key，只能在这里留一份。
_MODEL_KEYS: dict[str, str] = {}


def _ensure_registry() -> None:
    """幂等构建模型注册表：第一次用到时才读配置、建客户端。"""
    global MODELS, MODEL_META, _DEFAULT, _LOADED
    if _LOADED or MODELS is not _INITIAL_MODELS:
        return
    _MODEL_KEYS.clear()
    config = load_models()
    if config is None:
        # 没有桌面端配置：保持原来的两模型回退行为
        built, meta, default = _build_models(), _env_meta(), DEFAULT_MODEL
    else:
        built, meta, default = _build_from_config(config)
    MODELS = built
    MODEL_META = meta
    _DEFAULT = default
    _LOADED = True


def active_default() -> str:
    """当前默认模型名；默认模型被删后回落到第一个可用模型。"""
    _ensure_registry()
    if _DEFAULT in MODELS:
        return _DEFAULT
    return next(iter(MODELS), "")


def model_exists(name: str) -> bool:
    """注册表里是否有这个键（不做「退回默认模型」的兜底）。"""
    _ensure_registry()
    return name in MODELS


def resolve_model_name(name: str | None) -> str:
    """把调用方传的模型名解析成注册表里实际会用的键：落库记模型时必须用这个值。

    否则配置模式下不传 model 会被记成 `.env` 回退模式的 DEFAULT_MODEL，
    与实际答话的模型不一致，事后排查「换模型后输出变了」会被误导。
    """
    _ensure_registry()
    if name and name in MODELS:
        return name
    return active_default()


def get_model(name: str | None = None):
    """按名取模型；未指定或不存在时退回默认模型。"""
    _ensure_registry()
    if name and name in MODELS:
        return MODELS[name]
    default = active_default()
    return MODELS.get(default) or (next(iter(MODELS.values())) if MODELS else None)


def capability_of(name: str) -> dict:
    """模型展示信息（唯一源）：注册表键 = 前端传回的模型名。

    label 是用户填的显示名，model 是上游模型 ID（两者可能不同）；
    vision / reasoning 决定前端要不要禁用附件入口、显示「查看推理过程」。
    """
    _ensure_registry()
    meta = MODEL_META.get(name) or {}
    caps = MODEL_CAPABILITIES.get(name) or {}
    return {
        "name": name,
        "label": meta.get("label") or name,
        "provider": meta.get("provider") or "",
        "model": meta.get("model") or name,
        "vision": bool(meta.get("vision", caps.get("vision", False))),
        "reasoning": bool(meta.get("reasoning", caps.get("reasoning", False))),
        "speed": caps.get("speed", "fast"),
    }


def get_models_payload() -> dict:
    """模型列表接口响应；无可用模型给中文提示，不抛 500。"""
    _ensure_registry()
    if not MODELS:
        return {
            "models": [],
            "default": None,
            "message": "暂无可用模型：请在「设置 → 模型」里添加模型并填写 API Key",
        }
    default = active_default() or next(iter(MODELS))
    return {"models": [capability_of(name) for name in MODELS], "default": default}


def _friendly_error(text: str, secret: str = "", fallback: str = "") -> str:
    """把上游异常翻成能照做的中文；同时抹掉任何像 Key 的片段与本次真正用到的那把 Key。

    secret 先做确定性替换、正则只作兜底：只靠正则时，短于 32 位且没有已知前缀的 Key
    （多数中转 / 自建网关签发的形态）会原样漏进日志与 /models/verify 的响应。

    fallback 只给「会直接展示给用户的调用方」用（/models/verify）：兜底分支不再回显上游原文，
    上游文本里可能带上中转网关的内部地址、账号、计费提示。日志侧仍传空串保留原始原因。
    """
    if fallback and not text:
        return fallback
    raw = str(text or "")
    if secret:
        raw = raw.replace(secret, "sk-***")
    clean = _SECRET_PATTERN.sub("sk-***", raw)
    lowered = clean.lower()
    if "401" in lowered or "unauthorized" in lowered or "invalid api key" in lowered or "incorrect api key" in lowered:
        return "API Key 无效或已过期"
    if "403" in lowered or "permission" in lowered:
        return "这把 Key 没有访问该模型的权限"
    if "404" in lowered or "model not found" in lowered or "does not exist" in lowered:
        return "模型 ID 不存在：请核对填写的模型 ID"
    if "timeout" in lowered or "timed out" in lowered:
        return "连接超时：请检查网络或 Base URL"
    if "connection" in lowered or "connect" in lowered:
        return "连不上 Base URL：请检查地址与网络"
    if "429" in lowered or "rate limit" in lowered:
        return "请求过于频繁（429）：稍后再试"
    # 兜底：没有命中任何已知特征时，展示侧用调用方给的固定文案（不回显上游原文）
    return fallback or clean.strip()[:160] or "未知错误"


def verify_model(name: str) -> dict:
    """用某个模型发一次极轻量请求，判断 Key 与模型 ID 是否可用。

    为什么由后端发：Key 只在后端进程里（桌面端解密后注入），让前端探测等于把 Key
    交给页面。这里只回结论，不回 Key，也不把上游原文整段贴出去（可能含 Key 片段）。
    """
    _ensure_registry()
    if name not in MODELS:
        return {"ok": False, "error": "这个模型还没有配置 Key，或创建失败"}
    try:
        message = MODELS[name].bind(max_tokens=8).invoke("ping")
        reply = str(getattr(message, "content", "") or "")[:40]
        return {"ok": True, "reply": reply}
    except Exception as exc:  # noqa: BLE001  验证失败是正常分支
        # 日志保留清洗后的上游原因，响应只给固定文案：两个受众要的东西不一样
        logger.info("模型 %s 验证失败：%s", name, _friendly_error(str(exc), _MODEL_KEYS.get(name, "")))
        reason = _friendly_error(
            str(exc),
            _MODEL_KEYS.get(name, ""),
            fallback="连接失败：请检查 Base URL、模型 ID 与网络",
        )
        return {"ok": False, "error": reason}
