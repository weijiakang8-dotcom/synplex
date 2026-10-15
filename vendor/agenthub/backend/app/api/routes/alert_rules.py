import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.permissions import require_permission
from app.models import AlertRule

router = APIRouter(prefix="/alert-rules", tags=["alert-rules"])


class AlertRuleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    severity: str = "warning"
    condition: dict
    enabled: bool = True
    notification_channels: list = []


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    severity: str | None = None
    condition: dict | None = None
    enabled: bool | None = None
    notification_channels: list | None = None


@router.get("", response_model=None)
async def list_rules(session: SessionDep, user: CurrentUserDep) -> list[AlertRule]:
    stmt = select(AlertRule).order_by(AlertRule.created_at)
    if user.organization_id is not None:
        stmt = stmt.where(AlertRule.organization_id == user.organization_id)
    return list((await session.execute(stmt)).scalars().all())


@router.post(
    "",
    response_model=None,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def create_rule(
    payload: AlertRuleCreate, session: SessionDep, user: CurrentUserDep
) -> AlertRule:
    rule = AlertRule(**payload.model_dump(), organization_id=user.organization_id)
    session.add(rule)
    await session.commit()
    await session.refresh(rule)
    return rule


@router.put(
    "/{rule_id}",
    response_model=None,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def update_rule(
    rule_id: uuid.UUID,
    payload: AlertRuleUpdate,
    session: SessionDep,
    user: CurrentUserDep,
) -> AlertRule:
    rule = await session.get(AlertRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    if (
        user.organization_id is not None
        and rule.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Rule not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(rule, key, value)
    await session.commit()
    await session.refresh(rule)
    return rule


@router.delete(
    "/{rule_id}",
    status_code=204,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def delete_rule(
    rule_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    rule = await session.get(AlertRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    if (
        user.organization_id is not None
        and rule.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Rule not found")
    await session.delete(rule)
    await session.commit()


@router.post(
    "/{rule_id}/test", dependencies=[Depends(require_permission("resources:write"))]
)
async def test_rule(
    rule_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    rule = await session.get(AlertRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    if (
        user.organization_id is not None
        and rule.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Rule not found")
    return {"status": "ok", "rule": rule.name, "severity": rule.severity}
