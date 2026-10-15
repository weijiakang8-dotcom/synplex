from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.notification import send_notification
from app.models import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationTest(BaseModel):
    channel: str
    template: str = "alert"
    params: dict = {}


@router.get("")
async def list_notifications(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(Notification).order_by(Notification.created_at.desc()).limit(200)
    if user.organization_id is not None:
        stmt = stmt.where(Notification.organization_id == user.organization_id)
    result = await session.execute(stmt)
    return [
        {
            "id": str(n.id),
            "channel": n.channel,
            "template": n.template,
            "params": n.params,
            "status": n.status,
            "error": n.error,
            "created_at": n.created_at.isoformat(),
        }
        for n in result.scalars().all()
    ]


@router.post("/test")
async def test_notification(payload: NotificationTest, user: CurrentUserDep) -> dict:
    return await send_notification(
        payload.channel,
        payload.template,
        payload.params,
        str(user.organization_id) if user.organization_id else None,
    )
