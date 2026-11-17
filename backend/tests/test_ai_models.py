"""模型注册表的两条来源（桌面端配置 / .env 回退）与验证接口。

模型 Key 现在可能每个模型各一把：这里要钉住「选哪个模型就用哪个模型的 Key」，
以及「验证失败时给中文、且绝不把 Key 回显到响应里」。
"""
import pytest

from core import ai


def _cfg(models, default=""):
    return {"models": models, "default": default}


def _item(mid, name, model, base, key, vision=False, reasoning=False):
    return {
        "id": mid,
        "name": name,
        "provider": "custom",
        "model": model,
        "baseUrl": base,
        "apiKey": key,
        "vision": vision,
        "reasoning": reasoning,
    }


def test_build_from_config_uses_each_models_own_key(monkeypatch):
    created = []

    def fake_create(model, api_key, base_url):
        created.append((model, api_key, base_url))
        return object()

    monkeypatch.setattr(ai, "_create", fake_create)
    registry, meta, default = ai._build_from_config(
        _cfg(
            [
                _item("m-1", "DeepSeek", "deepseek-chat", "https://a/v1", "sk-a", vision=True),
                _item("m-2", "通义千问", "qwen-flash", "https://b/v1", "sk-b", reasoning=True),
            ],
            "m-2",
        )
    )

    assert set(registry) == {"m-1", "m-2"}
    assert created[0] == ("deepseek-chat", "sk-a", "https://a/v1")
    assert created[1] == ("qwen-flash", "sk-b", "https://b/v1")
    assert default == "m-2", "默认模型要按配置里的选择"
    assert meta["m-1"]["label"] == "DeepSeek"
    assert meta["m-2"]["reasoning"] is True


def test_build_from_config_skips_failed_model(monkeypatch):
    def fake_create(model, api_key, base_url):
        if model == "bad":
            raise RuntimeError("boom")
        return object()

    monkeypatch.setattr(ai, "_create", fake_create)
    registry, meta, default = ai._build_from_config(
        _cfg(
            [
                _item("m-bad", "坏的", "bad", "https://x/v1", "sk-x"),
                _item("m-ok", "好的", "ok", "https://y/v1", "sk-y"),
            ],
            "m-bad",
        )
    )

    assert list(registry) == ["m-ok"]
    assert "m-bad" not in meta
    assert default == "m-ok", "默认模型创建失败时要回落到可用的那个"


def test_build_from_config_with_nothing(monkeypatch):
    registry, meta, default = ai._build_from_config(_cfg([], "m-1"))
    assert registry == {} and meta == {} and default == ""


def test_payload_carries_label_and_upstream_model(monkeypatch):
    monkeypatch.setattr(ai, "MODELS", {"m-1": object()})
    monkeypatch.setattr(
        ai,
        "MODEL_META",
        {
            "m-1": {
                "label": "我的中转",
                "provider": "custom",
                "model": "gpt-4o-mini",
                "vision": True,
                "reasoning": False,
            }
        },
    )
    monkeypatch.setattr(ai, "_DEFAULT", "m-1")

    payload = ai.get_models_payload()
    item = payload["models"][0]

    assert item["name"] == "m-1", "前端仍用 name 作为选择值"
    assert item["label"] == "我的中转"
    assert item["model"] == "gpt-4o-mini"
    assert item["vision"] is True
    assert payload["default"] == "m-1"


def test_payload_without_models_points_to_settings(monkeypatch):
    monkeypatch.setattr(ai, "MODELS", {})
    payload = ai.get_models_payload()
    assert payload["models"] == []
    assert "设置" in payload["message"]


def test_verify_model_reports_success(monkeypatch):
    class Fake:
        def bind(self, **kwargs):
            assert kwargs.get("max_tokens") == 8, "验证必须是极轻量请求"
            return self

        def invoke(self, text):
            class Message:
                content = "pong"

            return Message()

    monkeypatch.setattr(ai, "MODELS", {"m-1": Fake()})
    assert ai.verify_model("m-1") == {"ok": True, "reply": "pong"}


def test_verify_model_unknown_id(monkeypatch):
    monkeypatch.setattr(ai, "MODELS", {})
    result = ai.verify_model("nope")
    assert result["ok"] is False
    assert "配置" in result["error"]


def test_verify_model_translates_401_and_hides_key(monkeypatch):
    class Boom:
        def bind(self, **kwargs):
            return self

        def invoke(self, text):
            raise RuntimeError("Error code: 401 - invalid api key: sk-abcdef1234567890")

    monkeypatch.setattr(ai, "MODELS", {"m-1": Boom()})
    result = ai.verify_model("m-1")

    assert result["ok"] is False
    assert "Key 无效" in result["error"]
    assert "sk-abcdef1234567890" not in result["error"], "任何 Key 片段都不能回显"


@pytest.mark.parametrize(
    "raw,hint",
    [
        ("Error code: 404 - model not found", "模型 ID 不存在"),
        ("Request timed out", "连接超时"),
        ("Connection refused", "连不上"),
        ("Error code: 429 - rate limit", "429"),
    ],
)
def test_friendly_error_table(raw, hint):
    assert hint in ai._friendly_error(raw)


def test_friendly_error_fallback_hides_upstream_text():
    """未命中任何已知特征时，展示侧必须用固定文案：上游原文可能带网关地址与账号信息。"""
    raw = "gateway acct-12345 at https://relay.internal/v1 rejected: quota policy 7"

    assert ai._friendly_error(raw) == raw, "日志侧仍要保留清洗后的原始原因"
    assert ai._friendly_error(raw, "", fallback="连接失败：请检查网络") == "连接失败：请检查网络"


def test_friendly_error_masks_short_key_without_known_prefix():
    """24 位、无 sk- 前缀的中转 Key：正则的「32 位以上」兜底抓不到，精确替换必须补上。

    走的是不命中任何关键词、原样返回清洗文本的那条分支，所以这条断言是有效的。
    """
    secret = "9f2c7b4ad81e0356c9a4b7e2"
    clean = ai._friendly_error(f"upstream said: invalid token {secret}", secret)
    assert secret not in clean


def test_verify_model_masks_exact_key(monkeypatch):
    """verify_model 的失败文案里不能出现这把 Key，哪怕它不符合任何已知前缀。"""
    secret = "9f2c7b4ad81e0356c9a4b7e2"

    class Boom:
        def bind(self, **kwargs):
            return self

        def invoke(self, text):
            raise RuntimeError(f"401 unauthorized; key={secret}")

    monkeypatch.setattr(ai, "MODELS", {"m-1": Boom()})
    monkeypatch.setattr(ai, "_MODEL_KEYS", {"m-1": secret})

    result = ai.verify_model("m-1")
    assert result["ok"] is False
    assert secret not in result["error"]
