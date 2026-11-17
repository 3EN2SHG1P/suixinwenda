"""账号业务：验证码、注册、密码登录、验证码登录（不写 HTTP，异常统一 BizError 分类）。"""
import hashlib
import logging
import os
import secrets
import threading
import time

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from core.config import require
from core.database import engine
from core.errors import BizError
from core.limits import NICKNAME_TEXT_MAX, USERNAME_MAX, clip
from core.security import (
    HASH_ITERATIONS,
    HASH_SALT_BYTES,
    create_access_token,
    hash_password,
    needs_rehash,
    verify_password,
)
from models.user import User

logger = logging.getLogger(__name__)

# 账号上限来自 core/limits.py（与 schemas/user.py 的入参校验同一来源）；
# 写入前自己截断，别指望 SQLite 拦（它完全忽略长度）
NICKNAME_MAX = 50

# 验证码记录：username -> (验证码, 发送时间)；进程内存储（进程内存储，重启即失效）
_codes: dict[str, tuple[str, float]] = {}
# 验证码记录的内存上限：超限时先清过期项，仍然满就拒绝新的发送，
# 绝不淘汰 TTL 内还没用的记录（否则刷接口就能把正常用户手里的验证码挤掉）
_CODE_SENT_MAX = 10_000
# 失败计数字典的容量上限：key 来自调用方（用户名随便填），无上限就是一条
# 「发几个请求让进程内存涨到 OOM」的路径。满了两条策略不同：
# 验证码侧已由 _CODE_SENT_MAX 挡住发送，登录失败侧超限后不再记录新 key（老 key 继续生效）
_FAIL_TRACK_MAX = 10_000
# 只有字典长到这个量级才做一次 O(n) 清理：每次登录都全量遍历等于把登录成本随历史失败数放大
_FAIL_TRACK_PURGE_AT = 512
# 验证码位数与重发冷却：随机 6 位；同一账号 60 秒内只允许发一次，
# 否则「知道你手机号的人」既能把你的码顶掉，又能拿接口当短信轰炸机
CODE_LENGTH = 6
CODE_COOLDOWN_SECONDS = 60
# 密码登录失败锁定：同账号连续失败到上限就锁 5 分钟，挡住在线撞库
LOGIN_FAIL_MAX = 5
LOGIN_LOCK_SECONDS = 300
# 密码登录失败记录：username -> (连续失败次数, 窗口到期时间)
_login_fails: dict[str, tuple[int, float]] = {}
# 验证码校验失败记录：username -> (连续失败次数, 窗口到期时间)
# 为什么验证码也要计数：6 位码在 5 分钟有效期内可无限次尝试，等于绕过密码侧的撞库防护；
# 只有「发送」有 60 秒冷却，管不住「拿同一个码反复试」
CODE_FAIL_MAX = 5
CODE_FAIL_LOCK_SECONDS = 300
_code_fails: dict[str, tuple[int, float]] = {}
# 账号不存在时也要跑一次同等开销的摘要运算，消除「账号是否存在」的时序差
_DUMMY_SALT = b"\x00" * HASH_SALT_BYTES

# 慢哈希预算（唯一源）：注册、密码校验、账号不存在时的假校验都要跑 60 万次 PBKDF2，
# 单次约 0.3~0.5 秒 CPU。失败锁定按「账号」计数，攻击者换随机账号就能绕过它，
# 所以再加一道与账号无关的全局闸：窗口内最多做这么多次慢哈希，超出直接 429。
# 正常用户不可能一分钟内注册/登录几十次，被挡住说明已经处于攻击状态。
# 为什么不用并发信号量：信号量要求每条路径都保证 release，漏一次就永久卡死；
# 滑动窗口只做计数，没有任何必须配对的资源，异常路径也安全。
HASH_BUDGET_PER_MINUTE_DEFAULT = 30
HASH_BUDGET_WINDOW_SECONDS = 60
# 窗口内的调用时间戳（单调递增地追加，清理时只从前缀删）
_hash_calls: list[float] = []
_hash_lock = threading.Lock()
# 验证码与失败计数是「读-判断-写」三步：FastAPI 把同步路由丢在线程池里跑，
# 两个并发请求可以同时通过冷却检查 / 同时把计数停在同一个值上。
# RLock 是因为 _check_code 会调用 _note_code_fail（同一线程重入）。
_state_lock = threading.RLock()


class UserBizError(BizError):
    """账号业务异常：message 给用户看（中文），kind 由路由层统一映射状态码。

    kind 取值：invalid = 参数/验证码类 400；unauthorized = 凭据错误 401；
    conflict = 冲突 409；too_many = 失败次数超限 429。
    """


def _hash_budget_limit() -> int:
    """本窗口允许的慢哈希次数；环境变量可调（压测与自动化用例需要更大额度）。

    非法值回落默认：这条路径在登录链路上，绝不能因为一个手误的配置就把整个账号功能打死。
    """
    raw = os.environ.get("AUTH_BUDGET_PER_MINUTE", "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    return HASH_BUDGET_PER_MINUTE_DEFAULT


def _hash_budget_try_acquire() -> bool:
    """尝试占用一次慢哈希预算；False 表示本窗口额度已用完。

    只在锁内做「清过期 + 追加」，没有等待、没有嵌套调用，不存在死锁面。
    记录数上限就是额度本身（默认 30），所以这里的 O(n) 清理可以忽略。
    """
    limit = _hash_budget_limit()
    now = time.time()
    with _hash_lock:
        keep_from = len(_hash_calls)
        for index, stamp in enumerate(_hash_calls):
            if now - stamp < HASH_BUDGET_WINDOW_SECONDS:
                keep_from = index
                break
        if keep_from:
            del _hash_calls[:keep_from]
        if len(_hash_calls) >= limit:
            return False
        _hash_calls.append(now)
        return True


def _require_hash_budget() -> None:
    """必须先拿到预算才能继续的路径（注册、密码校验、假校验），拿不到按 429 处理。"""
    if _hash_budget_try_acquire():
        return
    logger.warning(
        "慢哈希预算已用尽，拒绝本次请求（上限 %d 次 / %d 秒）",
        _hash_budget_limit(),
        HASH_BUDGET_WINDOW_SECONDS,
    )
    raise UserBizError("请求过于频繁，请稍后再试", "too_many")


def normalize_username(username: str) -> str:
    """账号归一化：去首尾空白 + 转小写。

    MySQL 的 utf8mb4_unicode_ci 本来大小写不敏感，SQLite 默认 BINARY 敏感。
    不归一化的话，「A@b.com 已注册」在 SQLite 上仍能用「a@b.com」注册成功，
    而同一份数据导到 MySQL 会直接撞唯一索引。
    """
    return (username or "").strip().lower()


def _nickname(username: str) -> str:
    """昵称默认规则：邮箱取 @ 前部分，手机号取后 4 位，其余（普通用户名）直接用原串。

    最后一条是给「不填手机号/邮箱也能注册」用的：账号就叫「小明」时，
    再套手机号规则会变成「小明」的最后 4 个字（不足 4 位就是「明」），明显不是用户想要的。
    """
    if "@" in username:
        return username.split("@", 1)[0]
    if username.isdigit():
        return username[-4:]
    return username


def _demo_code_mode() -> bool:
    """是否把验证码回显到响应体（唯一源 =『DEMO_CODE_MODE』）。

    默认关闭：回显等于「知道账号就能登录该账号」，而注册已经不需要验证码，
    所以关闭回显不影响任何正常流程，只在做验证码演示时显式置 1。
    关闭时验证码只进服务端日志（本机没有短信/邮件通道，日志就是唯一投递通道）。
    """
    return os.environ.get("DEMO_CODE_MODE", "0").strip() == "1"


def _new_code() -> str:
    """生成验证码：配了 MOCK_CODE 就用它（本机演示可复现），否则随机 6 位。"""
    fixed = os.environ.get("MOCK_CODE", "").strip()
    if fixed:
        return fixed
    return f"{secrets.randbelow(10**CODE_LENGTH):0{CODE_LENGTH}d}"


def _purge_expired_codes() -> None:
    """清掉已过期的验证码记录（发送与校验前各调一次，防内存只增不减）。"""
    ttl = int(require("CODE_EXPIRE_SECONDS"))
    now = time.time()
    with _state_lock:
        for name in [n for n, item in _codes.items() if now - item[1] > ttl]:
            _codes.pop(name, None)


def send_code(username: str) -> dict:
    """发验证码：生成一次性验证码并记录发送时间。

    记录数到上限时只清过期项；仍然满就拒绝新的发送请求——
    绝不淘汰 TTL 内还没用的记录，否则刷接口就能把正常用户手里的验证码挤掉。
    """
    # 归一化放在入口：验证码记录、失败计数、查库三处的 key 必须是同一份字符串
    username = normalize_username(username)
    _purge_expired_codes()
    now = time.time()
    # 1~2. 冷却检查与写入必须在同一临界区：两个并发请求都读到「还没发过」时，
    # 会把同一个账号的码连发两次（后一个顶掉前一个，用户拿到的可能是作废的那条）
    with _state_lock:
        record = _codes.get(username)
        if record is not None and now - record[1] < CODE_COOLDOWN_SECONDS:
            wait_seconds = int(CODE_COOLDOWN_SECONDS - (now - record[1])) + 1
            raise UserBizError(f"验证码已发送，请 {wait_seconds} 秒后再试", "invalid")
        if len(_codes) >= _CODE_SENT_MAX and username not in _codes:
            raise UserBizError("验证码请求过于频繁，请稍后再试", "invalid")
        # 生成并记录（演示通道没有短信/邮件服务，验证码一律只进服务端日志）
        code = _new_code()
        _codes[username] = (code, now)
    # 回显模式下码在响应体里，日志再写一遍等于让「能读日志的人」直接拿到登录态；
    # 不回显时日志是唯一投递通道（本机没有短信/邮件服务），必须保留
    if _demo_code_mode():
        logger.info("验证码已生成（演示模式，随响应回显）：%s", username)
    else:
        logger.info("验证码已生成（仅服务端日志可见）：%s -> %s", username, code)
    payload = {
        "username": username,
        "expires_in": int(require("CODE_EXPIRE_SECONDS")),
    }
    # 3. 仅演示模式回显（默认 0）；置 1 等于「凭账号即可登录」，只在本机演示时打开
    if _demo_code_mode():
        payload["code"] = code
    return payload


def _purge_expired_code_fails() -> None:
    """清掉窗口外的验证码失败记录（防内存只增不减）。

    只在字典长到阈值时扫一遍：每次校验都全量遍历会让正常路径的成本随历史失败数增长。
    """
    with _state_lock:
        if len(_code_fails) < _FAIL_TRACK_PURGE_AT:
            return
        now = time.time()
        for name in [n for n, item in _code_fails.items() if item[1] < now]:
            _code_fails.pop(name, None)


def _check_code_fail_locked(username: str) -> None:
    """该账号是否还在「验证码错误过多」的锁定期内。"""
    _purge_expired_code_fails()
    with _state_lock:
        item = _code_fails.get(username)
        if item is None:
            return
        count, until = item
        if count >= CODE_FAIL_MAX and time.time() < until:
            wait_minutes = max(1, int((until - time.time()) / 60))
            raise UserBizError(f"验证码错误次数过多，请 {wait_minutes} 分钟后再试", "too_many")


def _note_code_fail(username: str) -> None:
    """记一次验证码错误；到上限就把该账号手里的码作废，逼用户重新获取。

    作废是必须的：只锁「校验入口」而码还活着，锁定一过就能继续用同一个码试，
    等于把 5 次窗口拉长成「每 5 分钟 5 次」。
    """
    now = time.time()
    with _state_lock:
        count, until = _code_fails.get(username, (0, 0.0))
        # 窗口外的旧失败不累计，否则「隔很久错一次」也会被算成连续失败
        count = count + 1 if until > now else 1
        if username not in _code_fails and len(_code_fails) >= _FAIL_TRACK_MAX:
            # 字典已满：新 key 不再记录（已记录的老 key 继续生效），避免被任意用户名撑爆内存
            logger.debug("验证码失败计数已达上限，忽略新账号的计数：%s", username)
            return
        _code_fails[username] = (count, now + CODE_FAIL_LOCK_SECONDS)
        if count >= CODE_FAIL_MAX:
            _codes.pop(username, None)


def _check_code(username: str, code: str) -> None:
    """校验验证码：1. 是否处于错误锁定；2. 取该账号自己的码；3. 校有效期；4. 通过即消费。

    验证码按账号隔离且只能用一次，避免「知道账号 = 拿到该账号登录态」被反复利用。
    """
    _check_code_fail_locked(username)
    _purge_expired_codes()
    # 取码 → 比对 → 消费必须在同一临界区：否则同一个码被两个并发请求同时读到，
    # 两边都能通过「一次性」校验（验证码登录会被用两次）
    with _state_lock:
        record = _codes.get(username)
        if record is None:
            raise UserBizError("请先获取验证码", "invalid")
        if time.time() - record[1] > int(require("CODE_EXPIRE_SECONDS")):
            _codes.pop(username, None)
            raise UserBizError("验证码已过期，请重新获取", "invalid")
        if not secrets.compare_digest(str(code), record[0]):
            _note_code_fail(username)
            raise UserBizError("验证码错误", "invalid")
        _codes.pop(username, None)  # 一次性：用过即失效
        _code_fails.pop(username, None)  # 校验通过即清零：正常用户不该被历史错误拖累


def _find_user(session: Session, username: str) -> User | None:
    """按用户名查用户。"""
    return session.exec(select(User).where(User.username == username)).first()


def _public_user(user: User) -> dict:
    """对外可见的用户字段：不含密码摘要，也不含 status 这类内部状态。

    昵称必须由后端下发：前端以前自己按「邮箱取 @ 前、手机号取后 4 位」推导，
    与后端 _nickname 是两份实现，规则一改就两边显示不一致。
    """
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "avatar": user.avatar,
    }


def _token_payload(user: User) -> dict:
    """组装登录/注册响应：令牌 + 用户信息（前端不再自己推导昵称）。"""
    return {
        "access_token": create_access_token(user.id, user.username),
        "token_type": "bearer",
        "expires_in": int(require("JWT_EXPIRE_SECONDS")),
        "user": _public_user(user),
    }


def _ensure_enabled(user: User) -> None:
    """禁用账号（status != 1）不得登录；401 + 明确中文（管理员封禁要让当事人看得懂原因）。"""
    if user.status != 1:
        raise UserBizError("该账号已被禁用，请联系管理员", "unauthorized")


def register(username: str, password: str, code: str = "", nickname: str = "") -> dict:
    """注册：查重 → 落库 → 直接签发令牌（并发撞唯一索引按已注册处理）。

    验证码只在「调用方传了」时校验：本机账号不需要证明手机号/邮箱归属，
    注册的代价应该只有「想个名字 + 想个密码」。老客户端仍可带 code，行为不变。
    昵称不填则按账号推导（见 _nickname）。
    """
    username = normalize_username(username)
    if (code or "").strip():
        _check_code(username, code)
    with Session(engine) as session:
        if _find_user(session, username) is not None:
            raise UserBizError("该账号已注册", "conflict")
        # 查重之后才扣预算：重名冲突不跑慢哈希，不该占用额度
        _require_hash_budget()
        user = User(
            username=clip(username, USERNAME_MAX),
            password=hash_password(password),
            nickname=clip((nickname or "").strip() or _nickname(username), NICKNAME_MAX),
            avatar="",
            status=1,
            add_time=int(time.time()),
        )
        session.add(user)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise UserBizError("该账号已注册", "conflict")
        session.refresh(user)
        # 注册即登录：少一次「注册成功，请用密码登录」的往返，也避免明文密码留在输入框里
        return _token_payload(user)


def _purge_expired_login_fails() -> None:
    """清掉已过期的失败记录（防内存只增不减）。只在字典变大时才扫，避免每次登录 O(n)。"""
    with _state_lock:
        if len(_login_fails) < _FAIL_TRACK_PURGE_AT:
            return
        now = time.time()
        for name in [n for n, item in _login_fails.items() if item[1] < now]:
            _login_fails.pop(name, None)


def _check_login_allowed(username: str) -> None:
    """登录前先看该账号是否处于失败锁定中。

    锁定用 429（too_many）而不是 401：401 的语义是「登录态失效」，客户端看到会去清令牌、
    弹「请重新登录」，而这里恰恰是「密码错太多次，等几分钟」——与验证码锁定保持同一口径。
    """
    _purge_expired_login_fails()
    with _state_lock:
        item = _login_fails.get(username)
        if item is None:
            return
        count, until = item
        if count >= LOGIN_FAIL_MAX and time.time() < until:
            wait_minutes = max(1, int((until - time.time()) / 60))
            raise UserBizError(f"密码错误次数过多，请 {wait_minutes} 分钟后再试", "too_many")


def _note_login_fail(username: str) -> None:
    """记录一次登录失败：窗口内累计到上限即锁定到窗口结束。"""
    now = time.time()
    with _state_lock:
        count, until = _login_fails.get(username, (0, 0.0))
        # 窗口外的旧失败不再累计，否则「隔很久错一次」也会被算成连续失败
        count = count + 1 if until > now else 1
        if username not in _login_fails and len(_login_fails) >= _FAIL_TRACK_MAX:
            # 字典已满：不再为新用户名记账（老记录继续生效），防止被扫用户名撑爆内存
            logger.debug("登录失败计数已达上限，忽略新账号的计数：%s", username)
            return
        _login_fails[username] = (count, now + LOGIN_LOCK_SECONDS)


def _dummy_verify(password: str) -> None:
    """账号不存在时跑一次同等开销的摘要运算，只为消除时序差（结果丢弃）。"""
    hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _DUMMY_SALT, HASH_ITERATIONS)


def login(username: str, password: str) -> dict:
    """密码登录：用户不存在与密码错统一 401 同一句中文；连续失败到上限即临时锁定。"""
    username = normalize_username(username)
    _check_login_allowed(username)
    with Session(engine) as session:
        user = _find_user(session, username)
        if user is None:
            # 假校验同样受全局预算约束：它是「换随机账号就能绕开 per-account 锁定」的那条路径
            _require_hash_budget()
            _dummy_verify(password)
            _note_login_fail(username)
            raise UserBizError("用户名或密码错误", "unauthorized")
        _require_hash_budget()
        if not verify_password(password, user.password):
            _note_login_fail(username)
            raise UserBizError("用户名或密码错误", "unauthorized")
        with _state_lock:
            _login_fails.pop(username, None)  # 登录成功即清零
        _ensure_enabled(user)
        # 老摘要（裸 sha256）登录成功后自动升级为 PBKDF2 新格式。
        # 升级是可选动作：预算不足就跳过本次（下次登录还会再判一次），
        # 绝不能因为「升级摘要」把一次成功的登录变成 429。
        if needs_rehash(user.password) and _hash_budget_try_acquire():
            user.password = hash_password(password)
            session.add(user)
            session.commit()
        return _token_payload(user)


def login_by_code(username: str, code: str) -> dict:
    """验证码登录：账号不存在则自动注册（随机密码只存摘要），返回 is_new_user。"""
    username = normalize_username(username)
    with Session(engine) as session:
        user = _find_user(session, username)
        # 先判账号状态再消费验证码：禁用账号的验证码不该被白白吃掉，
        # 解禁后用户手里那条码还得能用（校验与消费是一次性动作）
        if user is not None:
            _ensure_enabled(user)
        _check_code(username, code)
        is_new_user = user is None
        if is_new_user:
            # 自动注册也要跑一次慢哈希：不扣预算的话「验证码接口 + 随机账号」就是另一条算力放大路径
            _require_hash_budget()
            user = User(
                username=clip(username, USERNAME_MAX),
                password=hash_password(secrets.token_hex(16)),
                nickname=clip(_nickname(username), NICKNAME_MAX),
                avatar="",
                status=1,
                add_time=int(time.time()),
            )
            session.add(user)
            try:
                session.commit()
            except IntegrityError:
                # 并发下已被抢先注册：回滚后按老用户登录
                session.rollback()
                user = _find_user(session, username)
                is_new_user = False
            if user is None:
                # 回滚后仍查不到（极端并发/脏数据）：给中文冲突提示，绝不能拿 None 去 refresh
                raise UserBizError("该账号状态异常，请稍后重试", "conflict")
            session.refresh(user)
        _ensure_enabled(user)  # 并发注册抢先落地时可能刚被禁用，这里再兜一次
        payload = _token_payload(user)
        payload["is_new_user"] = is_new_user
        return payload


def rename(user_id: int, nickname: str) -> dict:
    """改昵称：只动 nickname 一列，账号与已签发的令牌都不受影响。

    账号定下来不好改（改了等于换账号、历史会话归属全乱），所以把「名字」这一层单独放开。
    """
    nickname = (nickname or "").strip()
    if not 1 <= len(nickname) <= NICKNAME_TEXT_MAX:
        raise UserBizError(f"昵称须为 1-{NICKNAME_TEXT_MAX} 个字符", "invalid")
    with Session(engine) as session:
        user = session.get(User, user_id)
        if user is None:
            # 令牌有效但账号已被删掉：与 deps 的口径一致，按登录态无效处理
            raise UserBizError("登录状态无效，请重新登录", "unauthorized")
        user.nickname = clip(nickname, NICKNAME_MAX)
        session.add(user)
        session.commit()
        session.refresh(user)
        return _public_user(user)
