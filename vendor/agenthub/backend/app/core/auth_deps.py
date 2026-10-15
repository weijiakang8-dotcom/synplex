from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_token
from app.database import get_db as _get_db
from app.models import User

SessionDep = Annotated[AsyncSession, Depends(_get_db)]


async def get_current_user(
    session: SessionDep,
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> User:
    """解析 Bearer JWT，并返回当前用户。"""
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ")
        payload = decode_token(token)
        if payload and payload.get("type") == "access" and payload.get("sub"):
            try:
                user = await session.get(User, uuid.UUID(str(payload["sub"])))
            except (ValueError, TypeError):
                user = None
            if user is not None and user.is_active:
                return user

    raise HTTPException(status_code=401, detail="Invalid or missing authentication")


CurrentUserDep = Annotated[User, Depends(get_current_user)]
