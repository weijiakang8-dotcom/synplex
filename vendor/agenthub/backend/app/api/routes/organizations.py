from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.permissions import VALID_ROLES, require_permission
from app.models import User

router = APIRouter(prefix="/organization", tags=["organization"])


class MemberRoleUpdate(BaseModel):
    role: str


def _serialize(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.get(
    "/members",
    dependencies=[Depends(require_permission("members:manage"))],
)
async def list_members(session: SessionDep, current_user: CurrentUserDep) -> list[dict]:
    stmt = (
        select(User)
        .where(User.organization_id == current_user.organization_id)
        .order_by(User.created_at)
    )
    result = await session.execute(stmt)
    return [_serialize(user) for user in result.scalars().all()]


@router.patch(
    "/members/{user_id}",
    dependencies=[Depends(require_permission("members:manage"))],
)
async def update_member_role(
    user_id: uuid.UUID,
    payload: MemberRoleUpdate,
    session: SessionDep,
    current_user: CurrentUserDep,
) -> dict:
    if payload.role not in VALID_ROLES:
        raise HTTPException(
            status_code=422,
            detail={"code": "AUTH_001", "message": "无效的角色"},
        )
    if user_id == current_user.id:
        raise HTTPException(
            status_code=400,
            detail={"code": "AUTH_001", "message": "不能修改自己的角色"},
        )

    target = await session.get(User, user_id)
    if target is None or target.organization_id != current_user.organization_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "AUTH_001", "message": "成员不存在"},
        )

    target.role = payload.role
    await session.commit()
    await session.refresh(target)
    return _serialize(target)
