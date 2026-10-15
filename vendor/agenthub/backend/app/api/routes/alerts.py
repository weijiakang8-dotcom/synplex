import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.alerting import evaluate_alert_rules
from app.core.permissions import require_permission
from app.models import AlertEvent, utcnow

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    rule_id: str
    severity: str
    message: str
    status: str
    triggered_at: datetime
    resolved_at: datetime | None = None


@router.get("", response_model=list[AlertRead])
async def list_alerts(
    session: SessionDep, user: CurrentUserDep, status: str | None = None
) -> list[AlertEvent]:
    stmt = select(AlertEvent).order_by(AlertEvent.triggered_at.desc()).limit(200)
    if user.organization_id is not None:
        stmt = stmt.where(AlertEvent.organization_id == user.organization_id)
    if status:
        stmt = stmt.where(AlertEvent.status == status)
    return list((await session.execute(stmt)).scalars().all())


@router.get("/stats")
async def alert_stats(session: SessionDep, user: CurrentUserDep) -> dict:
    base = select(func.count()).select_from(AlertEvent)
    if user.organization_id is not None:
        base = base.where(AlertEvent.organization_id == user.organization_id)
    total = (await session.execute(base)).scalar() or 0
    active = (
        await session.execute(
            select(func.count())
            .select_from(AlertEvent)
            .where(
                AlertEvent.status == "active",
                *(
                    [AlertEvent.organization_id == user.organization_id]
                    if user.organization_id is not None
                    else []
                ),
            )
        )
    ).scalar() or 0
    resolved = total - active
    return {"total": total, "active": active, "resolved": resolved}


@router.get("/{alert_id}", response_model=AlertRead)
async def get_alert(
    alert_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> AlertEvent:
    alert = await session.get(AlertEvent, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    if (
        user.organization_id is not None
        and alert.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert


@router.post(
    "/evaluate",
    response_model=list[AlertRead],
    dependencies=[Depends(require_permission("resources:write"))],
)
async def evaluate() -> list[AlertEvent]:
    return await evaluate_alert_rules()


@router.post(
    "/{alert_id}/resolve",
    response_model=AlertRead,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def resolve(
    alert_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> AlertEvent:
    alert = await session.get(AlertEvent, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    if (
        user.organization_id is not None
        and alert.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.status = "resolved"
    alert.resolved_at = utcnow()
    await session.commit()
    return alert


@router.put(
    "/{alert_id}/resolve",
    response_model=AlertRead,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def resolve_put(
    alert_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> AlertEvent:
    return await resolve(alert_id, session, user)
