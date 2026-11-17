"""pytest 全局准备：用临时 SQLite 文件跑，不依赖任何外部服务。

为什么不再连 MySQL：测试直连真实库时，Ctrl+C / 断言先于 teardown 抛出都会把测试数据
留在用户自己的聊天库里；换成临时目录下的 SQLite 文件后，整场测试跑完就能整个删掉。
"""
import atexit
import itertools
import os
import shutil
import tempfile
from pathlib import Path

# 1) 必须用赋值而不是 setdefault：.env 里写了 DB_BACKEND=mysql 时要被压掉，
#    否则「以为在跑测试，其实连着真实库」
os.environ["DB_BACKEND"] = "sqlite"

# 2) DATA_DIR 必须在 import core.database 之前定死。
#    engine 是模块级单例，导入完成后再改环境变量不会让它换路径，
#    测试会静默连到 backend/data/suixinwenda.db（开发者真实数据）且全程不报错。
#    只能 session 级一个临时目录，不能每个测试一个 tmp_path。
_TEST_DATA_DIR = tempfile.mkdtemp(prefix="suixinwenda-test-")
os.environ["DATA_DIR"] = _TEST_DATA_DIR
atexit.register(shutil.rmtree, _TEST_DATA_DIR, ignore_errors=True)

import pytest  # noqa: E402
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402

import core.config  # noqa: E402,F401  触发 load_env()；已存在的环境变量它不会覆盖

# 1b) 剔除真实模型 Key —— 必须放在 import core.config 之后。
#    load_env() 会把 backend/.env 里的 DEEPSEEK_API_KEY 写进环境变量（只要进程里还没有），
#    放在它前面就等于白清：.env 里填了真 Key 的机器照样会建出真实模型。
#    留着真 Key 的后果有两条：①「依赖模型是否可用」的用例在本机成立、在 CI 不成立，
#    表现为本地全绿、CI 单点失败；② 测试会真的向上游发请求（花钱、依赖网络、结果不确定）。
#    测试必须自己注入 fake_model（见 fake_model fixture），不许借用环境里的真凭据。
for _key in ("DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY", "SUIXINWENDA_MODELS_FILE"):
    os.environ.pop(_key, None)

from core import db_info  # noqa: E402
from core import user as user_service  # noqa: E402
from core.database import create_tables  # noqa: E402

# 没有 .env 时也要能 collect：JWT 是唯一在 import/lifespan 期强制校验的配置。
# CODE_EXPIRE_SECONDS 一并给上：验证码相关用例会 require() 它，只靠本机 backend/.env
# 会让「本地全绿、CI 报缺少配置项」——CI 里并没有那份 .env。
for _key, _value in (
    ("JWT_SECRET", "t" * 40),
    ("JWT_EXPIRE_SECONDS", "604800"),
    ("CODE_EXPIRE_SECONDS", "300"),
):
    os.environ.setdefault(_key, _value)

# 演示验证码（的 MOCK_CODE）：测试统一用这个固定值，禁止在用例里写死 1234
DEMO_CODE = "246810"


@pytest.fixture(autouse=True)
def _auth_test_env(monkeypatch):
    """固定演示验证码、关掉重发冷却、清空登录失败记录。

    多数用例要在一个用例内对同一账号重复发码，开着 60 秒冷却会被自己挡住；
    冷却与失败锁定各有独立用例单独打开验证。
    """
    monkeypatch.setenv("MOCK_CODE", DEMO_CODE)
    # 验证码记录也一并清空：它是进程内共享字典，清掉后「验证码隔离」不再依赖账号随机
    monkeypatch.setattr(user_service, "_codes", {})
    monkeypatch.setattr(user_service, "CODE_COOLDOWN_SECONDS", 0)
    monkeypatch.setattr(user_service, "_login_fails", {})
    # 验证码失败计数同理：进程内共享字典，不清会让「错误次数」用例互相污染
    monkeypatch.setattr(user_service, "_code_fails", {})
    # 慢哈希全局限流：整套用例会在几十秒内注册/登录上百次，默认 30 次/分钟会误伤。
    # 这里是「把额度调大」，不是关掉检查——限流本身的行为由 test_auth_budget.py 单独打开验证。
    monkeypatch.setenv("AUTH_BUDGET_PER_MINUTE", "100000")
    # 预算用的滑动窗口是进程内共享列表：不清会让上一个用例占用的额度带到下一个
    monkeypatch.setattr(user_service, "_hash_calls", [])


@pytest.fixture(scope="session", autouse=True)
def _prepare_database():
    """建业务表（幂等），并顺手守住两条「误连真实数据」的红线。"""
    # 防止误连真实库：后端必须是 sqlite，且数据目录必须在本次的临时目录里
    assert db_info.db_backend() == "sqlite"
    assert db_info.sqlite_path().is_relative_to(Path(_TEST_DATA_DIR).resolve()), (
        f"测试库跑到了临时目录之外：{db_info.sqlite_path()}"
    )
    create_tables()
    yield


@pytest.fixture
def fake_model():
    """替身模型：逐字符流式输出固定中文，不发真实网络请求。

    必须是 BaseChatModel 子类：业务代码按 langchain 的接口调 `invoke` / `astream`，
    鸭子类型对象在取流式事件时会缺方法。
    """
    return GenericFakeChatModel(messages=itertools.cycle([AIMessage(content="你好")]))
