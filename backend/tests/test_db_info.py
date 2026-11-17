"""存储口径测试：判定规则错一条就是「老用户看见空列表」或「新用户起不来」。"""
import os

import pytest

from core import db_info


_DB_KEYS = (
    "DB_BACKEND",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_ALLOW_REMOTE",
    "DB_SSL_CA",
    "DATA_DIR",
)


@pytest.fixture(autouse=True)
def _clean_db_env():
    """每个用例从「什么都没配」开始，并在结束后把这些键**硬清空**。

    不用 monkeypatch.delenv：本文件里的用例习惯直接写 os.environ，
    而 monkeypatch 只负责「恢复成进入本用例时的样子」——一旦上面某个用例漏了清理，
    污染会顺着默认值一路带到 test_health（表现为「预期 False 实际 True」的死循环排查）。
    """
    saved = {key: os.environ.pop(key) for key in _DB_KEYS if key in os.environ}
    yield
    for key in _DB_KEYS:
        os.environ.pop(key, None)
    os.environ.update(saved)


def test_explicit_backend_wins():
    """显式写了 DB_BACKEND 就以它为准，不看 DB_HOST。"""
    os.environ["DB_BACKEND"] = "sqlite"
    os.environ["DB_HOST"] = "127.0.0.1"
    assert db_info.db_backend() == "sqlite"

    os.environ["DB_BACKEND"] = "mysql"
    assert db_info.db_backend() == "mysql"


def test_legacy_env_with_host_is_mysql_even_with_empty_password():
    """老用户 .env 里只有 DB_HOST 是实值也必须判 mysql——本地 MySQL 常见 root 空密码。

    这条判错的表现是「升级后会话列表空了」，是整份改动里唯一会让人以为丢数据的地方。
    """
    os.environ["DB_HOST"] = "127.0.0.1"
    assert db_info.db_backend() == "mysql"


def test_empty_everything_falls_back_to_sqlite():
    """什么都没配 = 新用户，必须落到 SQLite，否则起不来。"""
    assert db_info.db_backend() == "sqlite"


def test_data_dir_follows_env_and_sqlite_path_is_absolute(monkeypatch, tmp_path):
    """DATA_DIR 每次调用都要重新读；sqlite 路径必须是绝对路径（否则跟着 cwd 漂）。"""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert db_info.data_dir() == tmp_path
    assert db_info.sqlite_path() == (tmp_path / "suixinwenda.db").resolve()
    assert db_info.sqlite_path().is_absolute()


def test_sqlite_display_location_has_no_absolute_path(monkeypatch, tmp_path):
    """位置字段只给相对路径或文件名：绝对路径会把用户名暴露到接口与日志里。"""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    location = db_info.describe()["location"]
    assert location == "suixinwenda.db"
    assert ":" not in location and "\\" not in location


def test_storage_scope_separates_local_and_remote_mysql():
    """附件与备份按库身份分池：本地 MySQL 与远程 MySQL 必须是两个不同的 scope。

    只按 sqlite/mysql 分的话，两个库共用 uploads/mysql，空库启动的孤儿清理
    会把另一个库的附件全删掉——这是会真丢文件的那一类错。
    """
    os.environ["DB_BACKEND"] = "sqlite"
    assert db_info.storage_scope() == "sqlite"

    os.environ["DB_BACKEND"] = "mysql"
    os.environ["DB_HOST"] = "127.0.0.1"
    os.environ["DB_PORT"] = "3306"
    os.environ["DB_NAME"] = "suixinwenda"
    local = db_info.storage_scope()
    assert local == "mysql-127-0-0-1-3306-suixinwenda"

    os.environ["DB_HOST"] = "10.0.0.9"
    remote = db_info.storage_scope()
    assert remote != local
    assert remote == "mysql-10-0-0-9-3306-suixinwenda"


def test_storage_scope_is_a_safe_directory_name():
    """scope 会变成目录名与备份文件名：不能带 `/ : 空格`，也不能为空。"""
    os.environ["DB_BACKEND"] = "mysql"
    os.environ["DB_HOST"] = "2001:db8::1"
    os.environ["DB_NAME"] = "My DB/子库"
    scope = db_info.storage_scope()
    assert scope.startswith("mysql-")
    for char in ("/", "\\", ":", " "):
        assert char not in scope
    assert len(scope) <= 70


def test_is_remote_and_allow_remote():
    """远程判定只对 MySQL 有意义：SQLite 永远是本机。"""
    os.environ["DB_BACKEND"] = "sqlite"
    assert db_info.is_remote() is False
    os.environ["DB_BACKEND"] = "mysql"
    os.environ["DB_HOST"] = "192.168.1.10"
    assert db_info.is_remote() is True
    assert db_info.allow_remote() is False
    os.environ["DB_ALLOW_REMOTE"] = "1"
    assert db_info.allow_remote() is True


def test_ssl_connect_args_only_with_ca(monkeypatch):
    """有 CA 才走 TLS，且默认同时校验证书链与主机名；没有就保持默认连接。"""
    os.environ["DB_BACKEND"] = "mysql"
    assert db_info.ssl_connect_args() == {}

    monkeypatch.setenv("DB_SSL_CA", "C:/certs/ca.pem")
    assert db_info.ssl_connect_args() == {
        "ssl_ca": "C:/certs/ca.pem",
        "ssl_verify_cert": True,
        "ssl_verify_identity": True,
    }, "只校验证书链时，任何一张该 CA 签发的证书都能冒充目标服务器"

    os.environ["DB_BACKEND"] = "sqlite"
    assert db_info.ssl_connect_args() == {}, "SQLite 不该受 CA 影响"


def test_ssl_identity_can_be_skipped_only_explicitly(monkeypatch):
    """本机自签证书场景：只有显式写了 DB_SSL_NO_VERIFY_IDENTITY=1 才放宽主机名校验。"""
    os.environ["DB_BACKEND"] = "mysql"
    monkeypatch.setenv("DB_SSL_CA", "C:/certs/ca.pem")
    monkeypatch.setenv("DB_SSL_NO_VERIFY_IDENTITY", "1")
    args = db_info.ssl_connect_args()
    assert args["ssl_verify_cert"] is True
    assert "ssl_verify_identity" not in args


def test_validate_ssl_reports_missing_ca_in_chinese(monkeypatch):
    os.environ["DB_BACKEND"] = "mysql"
    monkeypatch.setenv("DB_SSL_CA", "C:/not-there/ca.pem")
    with pytest.raises(RuntimeError, match="证书文件不存在"):
        db_info.validate_ssl()


def test_validate_ssl_passes_when_file_exists(monkeypatch, tmp_path):
    ca = tmp_path / "ca.pem"
    ca.write_text("---", encoding="utf-8")
    os.environ["DB_BACKEND"] = "mysql"
    monkeypatch.setenv("DB_SSL_CA", str(ca))
    db_info.validate_ssl()


def test_validate_remote_blocks_remote_host_unless_allowed():
    """非本机 MySQL 必须显式放行，否则聊天记录会静默离开本机。"""
    os.environ["DB_HOST"] = "192.168.1.10"
    with pytest.raises(RuntimeError, match="DB_ALLOW_REMOTE=1"):
        db_info.validate_remote()

    os.environ["DB_ALLOW_REMOTE"] = "1"
    db_info.validate_remote()


def test_validate_remote_ignores_sqlite():
    """SQLite 模式下 DB_HOST 是残留值，不该拦启动。"""
    os.environ["DB_BACKEND"] = "sqlite"
    os.environ["DB_HOST"] = "192.168.1.10"
    db_info.validate_remote()


def test_sqlite_path_is_fixed_name(tmp_path):
    """库文件名唯一：sqlite_path 只认 data/suixinwenda.db，不再做旧名改名。"""
    os.environ["DB_BACKEND"] = "sqlite"
    os.environ["DATA_DIR"] = str(tmp_path)
    # 放一个「历史库文件」：它必须被完全忽略（不迁移、不覆盖、也不被当成目标）
    (tmp_path / "legacy-other.db").write_bytes(b"old")

    path = db_info.sqlite_path()

    assert path.name == "suixinwenda.db"
    assert not path.exists(), "不再从历史文件名迁数据"


def test_probe_swallows_connection_error(monkeypatch):
    """库连不上只返回 False：健康检查靠它区分「后端没起来」与「库坏了」，不能顺势 500。"""
    from core import database

    class BrokenEngine:
        def connect(self):
            raise RuntimeError("db down")

    monkeypatch.setattr(database, "engine", BrokenEngine())
    assert database.probe() is False
