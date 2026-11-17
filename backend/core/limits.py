"""字符串长度兜底：数据库约束在不同后端不一样，写入前先自己截断。"""

# 昵称（给人看的名字）长度上限：唯一源。
# 路由层的入参校验（schemas/user.py）与业务层截断（core/user.py）都读这里，
# 两处各写一个数字必然漂开，最后表现为「前端说 20 字，后端 422 说 50 字」。
NICKNAME_TEXT_MAX = 20

# 账号长度上限：唯一源。业务层截断（core/user.py）与入参校验（schemas/user.py）都读这里，
# 两处各写一个 50 时，改一处就会变成「接口放行、落库截断」或反过来。
USERNAME_MAX = 50


def clip(value: str | None, limit: int) -> str:
    """截断到指定长度（按字符计，与 max_length 的语义一致）。

    必须有：SQLite 完全忽略 VARCHAR(n)，超长值照存；MySQL 会报 1406（Data too long）。
    只靠数据库约束的话，问题会变成「SQLite 上能存、导出到 MySQL 就失败」，
    而这一步发生在用户看不见的地方。
    """
    return (value or "")[:limit]
