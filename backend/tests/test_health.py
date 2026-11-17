"""健康检查接口测试：FastAPI TestClient，覆盖正向与错误路径。"""
from fastapi.testclient import TestClient

import main
from main import app

client = TestClient(app)


def test_health_ok():
    """正向：GET /api/v1/health 返回统一成功结构，data 里带进程来源标记。

    code 恒为 0 是硬约定（start.ps1 与前端只认它）；来源标记让桌面端只清理自己起的残留进程。
    """
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    assert body["message"] == "服务正常"
    assert body["data"]["managed"] is False, "测试环境没有 SUIXINWENDA_MANAGED，必须报未托管"
    assert isinstance(body["data"]["pid"], int) and body["data"]["pid"] > 0
    # 库的状态单独一层：code 还是 0，库坏了不能让 start.ps1 误判成「后端没起来」
    assert body["data"]["db"]["backend"] in ("sqlite", "mysql")
    assert body["data"]["db"]["ok"] is True
    if body["data"]["db"]["backend"] == "sqlite":
        assert ":" not in body["data"]["db"]["location"], "位置字段不许出现盘符"


def test_health_reports_connection_view_without_password(monkeypatch):
    """连接表单回显：/health 的 db 段带 host/port/user/name，但**永远不带密码**。

    界面要显示「当前真正生效的连接」，否则切过 MySQL 之后再开设置看到的是一串
    硬编码默认值；但密码一旦进了响应，就会被任何能读 /health 的本机进程拿到。
    """
    monkeypatch.setenv("DB_BACKEND", "mysql")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "3307")
    monkeypatch.setenv("DB_USER", "app")
    monkeypatch.setenv("DB_PASSWORD", "super-secret-pw")
    monkeypatch.setenv("DB_NAME", "mydb")

    resp = client.get("/api/v1/health")
    body = resp.json()
    assert "super-secret-pw" not in resp.text, "密码不许出现在任何响应里"
    assert body["data"]["db"]["connection"] == {
        "host": "127.0.0.1",
        "port": "3307",
        "user": "app",
        "name": "mydb",
        # 连接性质：本机 host → 不是远程；没勾允许远程；没配 CA
        "remote": False,
        "allow_remote": False,
        "ssl": False,
        "ssl_ca": "",
    }


def test_health_connection_view_marks_remote_and_ssl(monkeypatch):
    """远程库与 TLS 必须能被界面看出：它们决定「切换会不会被拦」与警示文案。"""
    monkeypatch.setenv("DB_BACKEND", "mysql")
    monkeypatch.setenv("DB_HOST", "10.0.0.9")
    monkeypatch.setenv("DB_URL", "")
    monkeypatch.setenv("DB_USER", "app")
    monkeypatch.setenv("DB_PASSWORD", "pw")
    monkeypatch.setenv("DB_NAME", "mydb")
    monkeypatch.setenv("DB_ALLOW_REMOTE", "1")
    monkeypatch.setenv("DB_SSL_CA", "C:/certs/ca.pem")

    conn = client.get("/api/v1/health").json()["data"]["db"]["connection"]
    assert conn["remote"] is True
    assert conn["allow_remote"] is True
    assert conn["ssl"] is True
    assert conn["ssl_ca"] == "C:/certs/ca.pem"


def test_health_connection_view_empty_on_sqlite(monkeypatch):
    """SQLite 下四项全空：前端据此保留默认值，而不是把 mysql 的残留配置贴到表单里。"""
    monkeypatch.setenv("DB_BACKEND", "sqlite")
    monkeypatch.setenv("DB_HOST", "192.168.1.10")
    conn = client.get("/api/v1/health").json()["data"]["db"]["connection"]
    assert conn == {
        "host": "",
        "port": "",
        "user": "",
        "name": "",
        "remote": False,
        "allow_remote": False,
        "ssl": False,
        "ssl_ca": "",
    }


def test_health_reports_managed_when_env_set(monkeypatch):
    """托管标记只认环境变量：桌面端 spawn 时传 1，其它启动方式一律 False。"""
    monkeypatch.setenv("SUIXINWENDA_MANAGED", "1")
    assert client.get("/api/v1/health").json()["data"]["managed"] is True


def test_demo_login_exposed_only_when_non_loopback_and_demo_code(monkeypatch):
    """危险组合判定：监听非回环 + 验证码回显 才为真；任一条件不成立都不告警。"""
    monkeypatch.setenv("DEMO_CODE_MODE", "1")
    monkeypatch.setenv("BACKEND_HOST", "0.0.0.0")
    assert main.demo_login_exposed() is True

    for loopback in ("127.0.0.1", "localhost", "::1"):
        monkeypatch.setenv("BACKEND_HOST", loopback)
        assert main.demo_login_exposed() is False, f"{loopback} 是本机回环，不该告警"

    monkeypatch.setenv("BACKEND_HOST", "192.168.1.10")
    monkeypatch.setenv("DEMO_CODE_MODE", "0")
    assert main.demo_login_exposed() is False, "回显关了就不存在这条风险"


def test_health_wrong_method():
    """错误路径：健康检查只接受 GET，用 POST 调它返回 405（验的是本接口的方法白名单，不是框架默认 404）。"""
    resp = client.post("/api/v1/health")
    assert resp.status_code == 405
    assert "detail" in resp.json()
