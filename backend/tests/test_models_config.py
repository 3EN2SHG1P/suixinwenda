"""运行时模型配置的读取与规范化。

为什么单独测：这份文件是桌面端写的（明文 Key），后端只读。
读错一条的后果都是「界面上有模型、一聊就报错」或「明明配了却不出现」，而两者都不抛异常。
"""
import json

import pytest

from core import models_config


@pytest.fixture
def config_file(tmp_path, monkeypatch):
    path = tmp_path / "runtime-models.json"
    monkeypatch.setenv("SUIXINWENDA_MODELS_FILE", str(path))
    return path


def _write(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def test_no_env_means_no_config(monkeypatch):
    monkeypatch.delenv("SUIXINWENDA_MODELS_FILE", raising=False)
    assert models_config.load_models() is None


def test_missing_file_means_no_config(config_file):
    assert models_config.load_models() is None


def test_broken_json_falls_back(config_file):
    config_file.write_text("{not json", encoding="utf-8")
    assert models_config.load_models() is None


def test_normalizes_fields(config_file):
    _write(
        config_file,
        {
            "default": "m-1",
            "models": [
                {
                    "id": "m-1",
                    "name": "DeepSeek",
                    "provider": "deepseek",
                    "baseUrl": "https://api.deepseek.com/v1",
                    "model": "deepseek-chat",
                    "apiKey": "sk-test",
                    "vision": True,
                    "reasoning": False,
                }
            ],
        },
    )
    config = models_config.load_models()
    assert config["default"] == "m-1"
    assert config["models"][0]["name"] == "DeepSeek"
    assert config["models"][0]["vision"] is True


def test_skips_items_without_key_or_bad_url(config_file):
    """缺 Key / 地址不是 http(s) 的条目不注册：它们只会让聊天抛看不懂的上游错误。"""
    _write(
        config_file,
        {
            "models": [
                {"id": "a", "model": "x", "baseUrl": "https://a/v1", "apiKey": ""},
                {"id": "b", "model": "x", "baseUrl": "file:///c:/x", "apiKey": "sk-1"},
                {"id": "c", "model": "x", "baseUrl": "https://c/v1", "apiKey": "sk-2"},
            ]
        },
    )
    config = models_config.load_models()
    assert [item["id"] for item in config["models"]] == ["c"]


def test_empty_models_list_is_still_a_valid_config(config_file):
    """用户把模型删光时是「有效配置 + 0 个模型」，不能悄悄回退到 .env 的旧模型。"""
    _write(config_file, {"models": []})
    config = models_config.load_models()
    assert config == {"models": [], "default": ""}


def test_name_falls_back_to_model_id(config_file):
    _write(config_file, {"models": [{"id": "m-9", "model": "qwen-flash", "baseUrl": "https://q/v1", "apiKey": "sk-3"}]})
    assert models_config.load_models()["models"][0]["name"] == "qwen-flash"
