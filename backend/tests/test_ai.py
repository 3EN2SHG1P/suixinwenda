"""模型列表接口测试：只验结构与降级逻辑，不发真实网络请求。

另含「模型客户端必须带读超时与重试」的断言：这两项没传进去时接口照样 200，
但在上游不吐字时会让流式请求一直挂着（取消机制只在下一个 chunk 到来时才检查）。
"""
from fastapi.testclient import TestClient

import core.ai as ai
from main import app

client = TestClient(app)


def test_get_models_ok(monkeypatch, fake_model):
    """正向：GET /get_models 返回 models/default。

    用替身模型注入注册表，不依赖真实 Key——否则没配 Key 时这条唯一的正向用例会被静默跳过。
    """
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = client.get("/api/v1/get_models")
    assert resp.status_code == 200
    body = resp.json()
    assert "models" in body and "default" in body
    assert body["models"], "应至少有一个可用模型"
    # 能力对象数组：前端据此禁用附件、决定提示阈值，不再靠模型名硬编码
    first = body["models"][0]
    assert {"name", "vision", "reasoning", "speed"} <= set(first)
    assert body["default"] in [item["name"] for item in body["models"]]


def test_get_models_empty_returns_chinese_message(monkeypatch):
    """错误路径：无可用模型时 200 + 中文提示，绝不 500。"""
    import core.ai as ai

    monkeypatch.setattr(ai, "MODELS", {})
    resp = client.get("/api/v1/get_models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["models"] == []
    assert body["default"] is None
    assert "暂无可用模型" in body["message"]


def test_models_carry_timeout_and_retries(monkeypatch):
    """两个模型都要带读超时 60s 与重试 2 次。

    为什么要测到对象属性：`init_chat_model(timeout=...)` 走的是 pydantic 别名，
    字段名实际叫 `request_timeout`。只断言常量等于 60 无法发现「参数名写错、被静默忽略」——
    而一旦真的没传进去，上游不吐字时 stream() 会一直挂着，取消机制永远等不到下一个 chunk。
    """
    # 不依赖本地 .env：用假 Key 构一遍注册表，避免 CI 上没有真 Key 导致 MODELS 为空
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-unit-test-placeholder")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-unit-test-placeholder")

    registry = ai._build_models()

    assert set(registry) == {"deepseek-flash", "qwen-flash"}, "两个模型都应构建成功"
    for name, model in registry.items():
        assert model.request_timeout == 60, f"{name} 没带上读超时（timeout 参数可能没生效）"
        assert model.max_retries == 2, f"{name} 没带上重试次数"


def test_timeout_constants_are_sane():
    """常量取值本身也锁住：超时不能超过 5 分钟（等于没设），重试不能超过 3 次（放大限流）。"""
    assert ai.MODEL_TIMEOUT_SECONDS == 60
    assert ai.MODEL_MAX_RETRIES == 2
    assert 0 < ai.MODEL_TIMEOUT_SECONDS <= 300
    assert 0 <= ai.MODEL_MAX_RETRIES <= 3
