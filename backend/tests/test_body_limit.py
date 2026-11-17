"""请求体体积上限：只看 Content-Length 会被分块传输绕过，必须两条路都挡住。"""
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_chunked_json_body_is_rejected_without_content_length():
    """分块传输没有声明长度：中间件的 size 判断永远是 0，必须显式拒绝。

    否则 Starlette 会把整包读进内存再交给 Pydantic，2 MB 上限形同虚设。
    """

    def chunks():
        yield b'{"message": "hi"}'

    response = client.post(
        "/api/v1/chat",
        content=chunks(),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 411
    assert "Content-Length" in response.json()["detail"]


def test_normal_json_body_still_passes_the_middleware():
    """带长度头的正常请求不能被误伤（哪怕业务层后续会拒绝它）。"""
    response = client.post("/api/v1/chat", json={"message": ""})

    assert response.status_code != 411
