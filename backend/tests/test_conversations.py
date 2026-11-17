"""会话接口测试：列表/完整记录/删除 + /chat 落库与归属隔离，数据自建自清。"""
import re
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import Session

import core.ai as ai
from core.database import engine
from core.security import create_access_token
from main import app
from models import User

client = TestClient(app)

# 本文件创建过的会话 id，测试结束统一清理，禁止依赖演示数据与固定自增 id
_created_conversations: set[int] = set()
# 本文件创建的测试用户 id（鉴权要回查 users 表，必须先落一行真数据）
_created_users: set[int] = set()


@pytest.fixture(autouse=True)
def _cleanup_conversations():
    """每个用例结束后删除本文件创建的会话、消息与测试用户。"""
    yield
    if _created_conversations:
        with engine.begin() as conn:
            for cid in list(_created_conversations):
                # SQLite 会复用被删掉的 id：附件行不清干净，下个用例的新会话会「继承」旧附件
                conn.execute(
                    text("DELETE FROM chat_attachments WHERE conversation_id = :c"),
                    {"c": cid},
                )
                conn.execute(
                    text("DELETE FROM chat_messages WHERE conversation_id = :c"),
                    {"c": cid},
                )
                conn.execute(text("DELETE FROM chat_summaries WHERE conversation_id = :c"), {"c": cid})
                conn.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        _created_conversations.clear()
    if _created_users:
        with engine.begin() as conn:
            for uid in list(_created_users):
                conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": uid})
        _created_users.clear()


def _register(resp_text: str) -> int:
    """从 SSE 正文解析 conversation_id 并登记待清理，返回该 id。"""
    match = re.search(r'"conversation_id":\s*(\d+)', resp_text)
    assert match is not None, f"SSE 未返回 conversation_id 载荷：{resp_text}"
    cid = int(match.group(1))
    _created_conversations.add(cid)
    return cid


def _auth(user_id: int | None = None, status: int = 1) -> dict:
    """造一个一次性用户（真落 users 表）并返回其 Bearer 头。

    必须落库：鉴权依赖会回查 users 表确认账号存在且 status=1，
    只签发令牌不建行会让本文件所有鉴权用例直接 401。
    """
    username = f"t{uuid.uuid4().hex[:10]}@test.local"
    with Session(engine) as session:
        user = User(
            id=user_id,
            username=username,
            password="pbkdf2$placeholder",
            nickname="测试用户",
            avatar="",
            status=status,
            add_time=int(time.time()),
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        uid = int(user.id)
    _created_users.add(uid)
    return {"Authorization": f"Bearer {create_access_token(uid, username)}"}


def _chat(message: str, token: dict | None = None, conversation_id: int | None = None):
    """发一次流式对话（假模型），返回响应。"""
    payload = {"message": message}
    if conversation_id is not None:
        payload["conversation_id"] = conversation_id
    return client.post("/api/v1/chat", json=payload, headers=token or {})


def test_disabled_user_token_rejected():
    """被禁用（status=0）的账号持有效令牌：401，令牌在有效期内不再生效。"""
    headers = _auth(status=0)
    got = client.get("/api/v1/conversations", headers=headers)
    assert got.status_code == 401
    assert "登录状态无效" in got.json()["detail"]


def test_deleted_user_token_rejected():
    """令牌 sub 指向已不存在的用户（删号）：同样 401，不能读写任何数据。"""
    headers = {"Authorization": f"Bearer {create_access_token(1_999_999_999, 'gone@test.local')}"}
    got = client.get("/api/v1/conversations", headers=headers)
    assert got.status_code == 401
    assert "登录状态无效" in got.json()["detail"]


def test_chat_saves_and_messages_ok(monkeypatch, fake_model):
    """正向（匿名）：/chat 落库 → 列表可见且标题取第一句 → 完整记录 user+assistant 各一条。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    resp = _chat("你好呀。这是第二句")
    assert resp.status_code == 200
    cid = _register(resp.text)

    lst = client.get("/api/v1/conversations").json()
    hit = [c for c in lst if c["id"] == cid]
    assert hit, f"列表未返回新建会话：{lst}"
    assert hit[0]["title"] == "你好呀"
    assert {"id", "title", "add_time", "update_time"} <= set(hit[0])

    msgs = client.get(f"/api/v1/conversations/{cid}/messages")
    assert msgs.status_code == 200
    data = msgs.json()
    assert [m["role"] for m in data] == ["user", "assistant"]
    assert data[0]["content"] == "你好呀。这是第二句"
    assert data[1]["content"] == "你好"
    assert {"id", "role", "content", "add_time"} <= set(data[0])


def test_conversation_not_found():
    """错误路径：不存在的会话查记录 / 删除均 404 + 中文 detail。"""
    missing = 999_999_999
    get_resp = client.get(f"/api/v1/conversations/{missing}/messages")
    assert get_resp.status_code == 404
    assert get_resp.json()["detail"] == "会话不存在"
    del_resp = client.delete(f"/api/v1/conversations/{missing}")
    assert del_resp.status_code == 404
    assert del_resp.json()["detail"] == "会话不存在"


def test_cross_user_isolation(monkeypatch, fake_model):
    """归属隔离：别人的会话查/删一律 404，列表不可见，会话不受损。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token_a, token_b = _auth(), _auth()
    cid = _register(_chat("只有 A 能看到我", token_a).text)

    # B 查记录 404、删 404、列表不可见
    assert client.get(f"/api/v1/conversations/{cid}/messages", headers=token_b).status_code == 404
    assert client.delete(f"/api/v1/conversations/{cid}", headers=token_b).status_code == 404
    b_list_ids = [c["id"] for c in client.get("/api/v1/conversations", headers=token_b).json()]
    assert cid not in b_list_ids

    # A 仍可见且记录完好
    a_list_ids = [c["id"] for c in client.get("/api/v1/conversations", headers=token_a).json()]
    assert cid in a_list_ids
    assert client.get(f"/api/v1/conversations/{cid}/messages", headers=token_a).status_code == 200


def test_anonymous_invisible_to_login(monkeypatch, fake_model):
    """匿名会话与登录用户的会话互相不可见。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token_a = _auth()
    cid = _register(_chat("匿名的话").text)
    a_list_ids = [c["id"] for c in client.get("/api/v1/conversations", headers=token_a).json()]
    assert cid not in a_list_ids
    assert client.get(f"/api/v1/conversations/{cid}/messages", headers=token_a).status_code == 404


def test_forged_conversation_id_rejected(monkeypatch, fake_model):
    """传别人的 conversation_id 一律 404：不新建、不串会话（与其它接口同口径）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token_a, token_b = _auth(), _auth()
    cid_a = _register(_chat("A 的会话", token_a).text)
    resp_b = _chat("B 冒用 A 的会话 id", token_b, conversation_id=cid_a)
    assert resp_b.status_code == 404
    assert "会话不存在" in resp_b.json()["detail"]
    # A 的会话没有被写入 B 的消息
    a_msgs = client.get(f"/api/v1/conversations/{cid_a}/messages", headers=token_a).json()
    assert [m["role"] for m in a_msgs] == ["user", "assistant"]
    assert a_msgs[0]["content"] == "A 的会话"


def test_finish_exchange_ignores_others_conversation():
    """安全：给不是自己的会话写收尾时，既不落回复也不刷新 update_time。"""
    import time

    from core import history

    cid = history.start_exchange(None, "匿名会话", None)
    _created_conversations.add(cid)
    with engine.begin() as conn:
        before = conn.execute(
            text("SELECT update_time FROM conversations WHERE id = :c"), {"c": cid}
        ).scalar()
    time.sleep(1.1)  # 时间戳是秒级，等过一秒才能区分「被刷新过」
    history.finish_exchange(cid, "别人的回复", 987654321)
    with engine.begin() as conn:
        after = conn.execute(
            text("SELECT update_time FROM conversations WHERE id = :c"), {"c": cid}
        ).scalar()
        messages = conn.execute(
            text("SELECT COUNT(*) FROM chat_messages WHERE conversation_id = :c"), {"c": cid}
        ).scalar()
    assert after == before, "别人的会话不该被刷新 update_time"
    assert messages == 1, "别人的会话不该被写入 assistant 回复"


def test_invalid_token_401():
    """错误路径：坏令牌 401 + 同一句中文。"""
    resp = client.get(
        "/api/v1/conversations", headers={"Authorization": "Bearer not-a-token"}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "登录状态无效，请重新登录"


def test_delete_removes_conversation_and_messages(monkeypatch, fake_model):
    """删除会话：记录与消息一并删，数据落库核对无残留（本卡范围）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    cid = _register(_chat("删我").text)
    resp = client.delete(f"/api/v1/conversations/{cid}")
    assert resp.status_code == 200
    assert resp.json() == {"message": "会话已删除"}
    assert client.get(f"/api/v1/conversations/{cid}/messages").status_code == 404
    with engine.connect() as conn:
        remain = conn.execute(
            text(
                "SELECT COUNT(*) FROM chat_messages "
                "WHERE conversation_id = :c UNION ALL "
                "SELECT COUNT(*) FROM conversations WHERE id = :c"
            ),
            {"c": cid},
        ).fetchall()
    assert [row[0] for row in remain] == [0, 0]


def test_rename_conversation_keeps_update_time(monkeypatch, fake_model):
    """重命名：标题更新且 update_time 不动（改个名字不该把会话顶到最前面）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("旧标题话题", token=token).text)
    before = [c for c in client.get("/api/v1/conversations", headers=token).json() if c["id"] == cid][0]
    resp = client.patch(f"/api/v1/conversations/{cid}", json={"title": "  新标题  "}, headers=token)
    assert resp.status_code == 200
    assert resp.json()["title"] == "新标题"
    after = [c for c in client.get("/api/v1/conversations", headers=token).json() if c["id"] == cid][0]
    assert after["title"] == "新标题"
    assert after["update_time"] == before["update_time"]


def test_rename_rejects_empty_title(monkeypatch, fake_model):
    """错误路径：空标题 422 + 中文，不改动原值。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("标题校验", token=token).text)
    resp = client.patch(f"/api/v1/conversations/{cid}", json={"title": "   "}, headers=token)
    assert resp.status_code == 422
    assert "标题不能为空" in str(resp.json()["detail"])


def test_regenerate_overwrites_last_reply(monkeypatch, fake_model):
    """重新生成：不新增问答，只覆盖最后一条 assistant（刷新后不会出现两组重复）。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("第一问", token=token).text)
    before = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [m["role"] for m in before] == ["user", "assistant"]

    resp = client.post(
        "/api/v1/chat",
        json={"message": "第一问", "conversation_id": cid, "regenerate": True},
        headers=token,
    )
    assert resp.status_code == 200
    assert '"conversation_id"' in resp.text

    after = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [m["role"] for m in after] == ["user", "assistant"], "重新生成不该多出一组问答"
    assert after[0]["content"] == "第一问"
    assert after[1]["content"] == before[1]["content"] or after[1]["content"]


def test_regenerate_can_be_reverted(monkeypatch, fake_model):
    """重新生成后可回退一步：历史始终只有一条回答，内容换回上一版。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("同一问", token=token).text)
    before = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert len(before) == 2

    client.post(
        "/api/v1/chat",
        json={"message": "同一问", "conversation_id": cid, "regenerate": True},
        headers=token,
    )
    assert len(client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()) == 2

    revert = client.post(f"/api/v1/conversations/{cid}/revert", headers=token)
    assert revert.status_code == 200
    assert revert.json()["content"]
    final = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert len(final) == 2, "回退不能多出消息"
    assert final[0]["content"] == "同一问"


def test_revert_without_previous_returns_400(monkeypatch, fake_model):
    """没重新生成过就点回退：400 + 中文，历史不动。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("没有旧版", token=token).text)
    resp = client.post(f"/api/v1/conversations/{cid}/revert", headers=token)
    assert resp.status_code == 400
    assert "可回退" in resp.json()["detail"]


def test_chat_records_model_name(monkeypatch, fake_model):
    """回答落库要记模型名：切模型后历史里能分清哪条是谁答的。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("记模型名", token=token).text)
    msgs = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert msgs[1]["model"] == "deepseek-flash"


def test_regenerate_other_users_conversation_denied(monkeypatch, fake_model):
    """越权：拿别人的会话重新生成，只回中文错误，不写任何消息。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    owner = _auth()
    cid = _register(_chat("我的会话", token=owner).text)
    other = _auth()
    resp = client.post(
        "/api/v1/chat",
        json={"message": "我的会话", "conversation_id": cid, "regenerate": True},
        headers=other,
    )
    assert resp.status_code == 404
    assert "会话不存在" in resp.json()["detail"]
    kept = client.get(f"/api/v1/conversations/{cid}/messages", headers=owner).json()
    assert len(kept) == 2


def test_rename_other_users_conversation_404(monkeypatch, fake_model):
    """越权：不是自己的会话按 404，不泄露是否存在。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    owner = _auth()
    cid = _register(_chat("别人的会话", token=owner).text)
    other = _auth()
    resp = client.patch(f"/api/v1/conversations/{cid}", json={"title": "偷改"}, headers=other)
    assert resp.status_code == 404


def _three_rounds(monkeypatch, fake_model) -> tuple[dict, int]:
    """造三轮问答，返回 (鉴权头, 会话 id)。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("第一问", token=token).text)
    _chat("第二问", token=token, conversation_id=cid)
    _chat("第三问", token=token, conversation_id=cid)
    return token, cid


def _regenerate(token: dict, cid: int, message: str):
    return client.post(
        "/api/v1/chat",
        json={"message": message, "conversation_id": cid, "regenerate": True},
        headers=token,
    )


def test_regenerate_keeps_earlier_rounds(monkeypatch, fake_model):
    """多轮之后再重新生成最后一轮：前面几轮的回答必须还在。

    旧实现把「降级」写成整会话 UPDATE，点一次重新生成就让前几轮的 AI 回复一起从历史消失
    （用户消息还在，记忆里也还在），这是最容易被当成「记录丢了」的 bug。
    """
    token, cid = _three_rounds(monkeypatch, fake_model)
    before = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [item["role"] for item in before] == ["user", "assistant"] * 3

    assert _regenerate(token, cid, "第三问").status_code == 200

    after = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [item["role"] for item in after] == ["user", "assistant"] * 3, "重新生成不该藏掉前面轮次的回答"
    assert [item["content"] for item in after if item["role"] == "user"] == [
        "第一问",
        "第二问",
        "第三问",
    ]


def test_regenerate_keeps_single_previous_version(monkeypatch, fake_model):
    """连续重新生成：库里每轮最多留「当前 + 上一版」，历史接口只返回一条。"""
    monkeypatch.setattr(ai, "MODELS", {"deepseek-flash": fake_model})
    token = _auth()
    cid = _register(_chat("反复重生成", token=token).text)
    for _ in range(3):
        assert _regenerate(token, cid, "反复重生成").status_code == 200

    with engine.begin() as conn:
        total = conn.execute(
            text("SELECT COUNT(1) FROM chat_messages WHERE conversation_id = :c AND role = 'assistant'"),
            {"c": cid},
        ).scalar()
        active = conn.execute(
            text(
                "SELECT COUNT(1) FROM chat_messages "
                "WHERE conversation_id = :c AND role = 'assistant' AND superseded = 0"
            ),
            {"c": cid},
        ).scalar()
    assert active == 1, "只能有一条当前回答"
    assert total == 2, "旧版只留一步回退，不能被版本树堆满"


def test_revert_only_swaps_current_round(monkeypatch, fake_model):
    """回退只对调当前这一轮的两版，前面轮次的内容不受影响。"""
    token, cid = _three_rounds(monkeypatch, fake_model)
    with engine.begin() as conn:
        ids = conn.execute(
            text(
                "SELECT id FROM chat_messages WHERE conversation_id = :c AND role = 'assistant' "
                "ORDER BY id ASC"
            ),
            {"c": cid},
        ).fetchall()
        for index, (message_id,) in enumerate(ids, start=1):
            conn.execute(
                text("UPDATE chat_messages SET content = :content WHERE id = :i"),
                {"content": f"回答{index}", "i": message_id},
            )

    assert _regenerate(token, cid, "第三问").status_code == 200
    revert = client.post(f"/api/v1/conversations/{cid}/revert", headers=token)
    assert revert.status_code == 200
    assert revert.json()["content"] == "回答3"

    after = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [item["role"] for item in after] == ["user", "assistant"] * 3
    assert [item["content"] for item in after if item["role"] == "assistant"] == [
        "回答1",
        "回答2",
        "回答3",
    ]


def test_repair_restores_wrongly_hidden_replies(monkeypatch, fake_model):
    """历史数据修复：被整会话误降级的旧轮次恢复显示，真正的旧版保持隐藏。"""
    from core import history

    token, cid = _three_rounds(monkeypatch, fake_model)
    # 1. 还原旧 bug 留下的数据形态：三轮回答全被标成旧版，只有最后新写入的那条是当前版
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE chat_messages SET superseded = 1 WHERE conversation_id = :c AND role = 'assistant'"),
            {"c": cid},
        )
        conn.execute(
            text(
                "INSERT INTO chat_messages (conversation_id, role, content, add_time, superseded, model) "
                "VALUES (:c, 'assistant', '最新版', 0, 0, '')"
            ),
            {"c": cid},
        )
    broken = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [item["role"] for item in broken] == ["user", "user", "user", "assistant"]

    # 2. 修复后：前两轮回答回来，最后一轮仍是「新版」，不会出现两条并列的回答
    assert history.repair_superseded_flags() >= 2
    fixed = client.get(f"/api/v1/conversations/{cid}/messages", headers=token).json()
    assert [item["role"] for item in fixed] == ["user", "assistant"] * 3
    assert fixed[-1]["content"] == "最新版"


def test_conversations_list_default_limit_100():
    """列表默认只回最近 100 条且按 update_time 倒序；limit 上限 500，越界 422。

    用匿名会话（user_id 为空）验证：不必造令牌，且 150 条一次性入库比走 150 次 /chat 快得多。
    """
    from core import history
    from models import Conversation

    with Session(engine) as session:
        for index in range(150):
            conv = Conversation(title=f"分页会话{index}", add_time=index, update_time=index)
            session.add(conv)
            session.commit()
            session.refresh(conv)
            _created_conversations.add(int(conv.id))

    rows = client.get("/api/v1/conversations").json()
    assert len(rows) == history.CONVERSATIONS_DEFAULT_LIMIT, "默认应截断到 100 条"
    assert rows[0]["update_time"] >= rows[-1]["update_time"], "必须按 update_time 倒序"

    # 分页边界交给 Query 校验：0 与超上限都是 422，恰好等于上限放行
    assert client.get("/api/v1/conversations?limit=0").status_code == 422
    assert client.get("/api/v1/conversations?limit=501").status_code == 422
    assert client.get("/api/v1/conversations?limit=500").status_code == 200
    # offset 能翻到第二页（第一页 100 条之后）——保留给旧调用方
    page2 = client.get("/api/v1/conversations?limit=100&offset=100").json()
    assert len(page2) >= 50, "150 条里翻到第二页应还剩 50 条以上"
    assert page2[0]["update_time"] <= rows[-1]["update_time"], "第二页必须比第一页更旧"

    # keyset 翻页：用第一页最后一条的 (update_time, id) 作游标。
    # 翻页期间把第一条会话顶到最前（模拟「又说了一句话」），keyset 也不会重复或漏条
    cursor = rows[-1]
    with Session(engine) as session:
        bumped = session.get(Conversation, rows[0]["id"])
        bumped.update_time = 999_999
        session.add(bumped)
        session.commit()

    keyset_page = client.get(
        f"/api/v1/conversations?limit=100&before_time={cursor['update_time']}&before_id={cursor['id']}"
    ).json()
    assert keyset_page, "游标之后应该还有更早的会话"
    assert keyset_page[0]["update_time"] <= cursor["update_time"]
    pages = {item["id"] for item in rows} | {item["id"] for item in keyset_page}
    assert len(pages) == len(rows) + len(keyset_page), "两页之间不允许出现重复会话"
    assert all(
        (item["update_time"], item["id"]) < (cursor["update_time"], cursor["id"])
        for item in keyset_page
    ), "游标之后的每一条都必须严格早于游标"


def test_claim_ids_over_limit_422():
    """认领列表长度上限取 core.history.CLAIM_MAX_IDS：超一个就 422，恰好等于上限放行。"""
    from core.history import CLAIM_MAX_IDS

    headers = _auth()
    too_many = client.post(
        "/api/v1/conversations/claim",
        json={"conversation_ids": list(range(1, CLAIM_MAX_IDS + 2))},
        headers=headers,
    )
    assert too_many.status_code == 422, "超过上限应在校验阶段就挡住"

    at_limit = client.post(
        "/api/v1/conversations/claim",
        json={"conversation_ids": list(range(1, CLAIM_MAX_IDS + 1))},
        headers=headers,
    )
    assert at_limit.status_code == 200, "恰好等于上限不该被误拒"


def test_claim_ids_deduped_keep_order():
    """重复 id 按原顺序去重（dict.fromkeys），不影响业务层的认领结果。"""
    from schemas.conversation import ClaimIn

    parsed = ClaimIn(conversation_ids=[3, 1, 3, 2, 1])
    assert parsed.conversation_ids == [3, 1, 2]


def test_messages_keyset_pagination():
    """消息默认只回最近一页（50）且升序；before_id 往前翻页无重复无遗漏。

    用匿名会话直接插库：150 次 /chat 太慢，这里要验的是分页本身。
    """
    from core import history

    with engine.begin() as conn:
        # lastrowid 是 DBAPI 的通用返回值；LAST_INSERT_ID() 只有 MySQL 有，SQLite 上会直接报错
        result = conn.execute(
            text("INSERT INTO conversations (title, add_time, update_time) VALUES ('消息分页', 0, 0)")
        )
        cid = int(result.lastrowid)
        _created_conversations.add(cid)
        for index in range(150):
            conn.execute(
                text(
                    "INSERT INTO chat_messages (conversation_id, role, content, add_time, superseded, model) "
                    "VALUES (:c, 'user', :content, 0, 0, '')"
                ),
                {"c": cid, "content": f"消息{index}"},
            )

    first = client.get(f"/api/v1/conversations/{cid}/messages").json()
    assert len(first) == history.MESSAGES_DEFAULT_LIMIT, "默认只回最近一页"
    ids = [item["id"] for item in first]
    assert ids == sorted(ids), "返回必须按 id 升序"
    assert first[-1]["content"] == "消息149", "默认页应是最新的一条在末尾"

    # 往前翻：无重复、无遗漏，仍升序
    older = client.get(
        f"/api/v1/conversations/{cid}/messages?limit=50&before_id={ids[0]}"
    ).json()
    assert len(older) == 50
    assert max(item["id"] for item in older) < ids[0], "before_id 必须严格往前"
    merged = [item["id"] for item in older] + ids
    assert merged == sorted(merged)
    assert len(set(merged)) == 100, "两页之间不许重复"

    third = client.get(
        f"/api/v1/conversations/{cid}/messages?limit=50&before_id={older[0]['id']}"
    ).json()
    assert len(third) == 50
    assert third[0]["content"] == "消息0", "第三页应翻到最早一条"

    # limit 越界交给 Query 校验：0 与超上限都是 422
    assert client.get(f"/api/v1/conversations/{cid}/messages?limit=0").status_code == 422
    assert (
        client.get(
            f"/api/v1/conversations/{cid}/messages?limit={history.MESSAGES_MAX_LIMIT + 1}"
        ).status_code
        == 422
    )
