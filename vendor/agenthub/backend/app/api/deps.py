from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Query, WebSocket

from app.config import settings
from app.core.auth_deps import CurrentUserDep, SessionDep, get_current_user
from app.models import User

logger = logging.getLogger(__name__)

if not settings.ADMIN_API_KEY:
    logger.warning(
        "ADMIN_API_KEY is not set; admin fallback authentication is disabled."
    )


async def get_admin_api_key_user(
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> User:
    """仅用于明确的 admin-only 运维接口。"""
    if not settings.ADMIN_API_KEY or x_api_key != settings.ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin API key")
    return User(
        email="admin@local",
        full_name="Super Admin",
        role="admin",
        is_active=True,
        organization_id=None,
    )


async def get_current_user_ws(
    websocket: WebSocket,
    session: SessionDep,
    token: Annotated[str | None, Query()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> User:
    """WebSocket 认证：优先从 Header 读取，其次从 ?token= 读取。"""
    auth_header = authorization
    if not auth_header and token:
        auth_header = f"Bearer {token}"
    try:
        return await get_current_user(session, auth_header, x_api_key)
    except HTTPException:
        await websocket.close(code=1008)
        raise


CurrentUserWsDep = Annotated[User, Depends(get_current_user_ws)]


async def get_current_org(user: CurrentUserDep) -> uuid.UUID | None:
    return user.organization_id


CurrentOrgDep = Annotated[uuid.UUID | None, Depends(get_current_org)]
