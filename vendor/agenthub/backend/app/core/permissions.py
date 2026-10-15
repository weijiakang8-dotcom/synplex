from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException

from app.core.auth_deps import CurrentUserDep
from app.models import User

ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"
ROLE_VIEWER = "viewer"

VALID_ROLES = {ROLE_ADMIN, ROLE_MEMBER, ROLE_VIEWER}

# 权限 -> 允许的角色。admin 作为超级管理员始终放行。
PERMISSION_ROLES: dict[str, set[str]] = {
    "models:manage": {ROLE_ADMIN},
    "members:manage": {ROLE_ADMIN},
    "audit:view": {ROLE_ADMIN},
    "operations:manage": {ROLE_ADMIN},
    "executions:write": {ROLE_ADMIN, ROLE_MEMBER},
    "resources:write": {ROLE_ADMIN, ROLE_MEMBER},
}


def _check_role(user: User, allowed: set[str]) -> None:
    if user.role == ROLE_ADMIN:
        return
    if user.role not in allowed:
        raise HTTPException(
            status_code=403,
            detail={"code": "FORBIDDEN", "message": "没有执行该操作的权限"},
        )


def require_role(*roles: str) -> Callable:
    allowed = set(roles)

    async def dependency(user: CurrentUserDep) -> User:
        _check_role(user, allowed)
        return user

    return dependency


def require_permission(permission: str) -> Callable:
    allowed = PERMISSION_ROLES.get(permission, set())

    async def dependency(user: CurrentUserDep) -> User:
        _check_role(user, allowed)
        return user

    return dependency
