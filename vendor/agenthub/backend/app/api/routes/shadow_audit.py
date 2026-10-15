from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query

from app.adapters import shadow_audit_repository
from app.api.deps import CurrentUserDep
from app.schemas.shadow_audit import ShadowAuditView

router = APIRouter(tags=["shadow-audits"])


@router.get("/shadow-audits/stats")
async def shadow_audit_stats(user: CurrentUserDep) -> dict:
    return await shadow_audit_repository.stats(organization_id=user.organization_id)


@router.get("/shadow-audits", response_model=list[ShadowAuditView])
async def list_shadow_audits(
    user: CurrentUserDep,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    shadow_status: str | None = None,
    kernel_goal_status: str | None = None,
    execution_id: uuid.UUID | None = None,
    workflow_id: uuid.UUID | None = None,
) -> list[ShadowAuditView]:
    return await shadow_audit_repository.list_recent(
        limit=limit,
        offset=offset,
        shadow_status=shadow_status,
        kernel_goal_status=kernel_goal_status,
        execution_id=execution_id,
        workflow_id=workflow_id,
        organization_id=user.organization_id,
    )


@router.get("/shadow-audits/{audit_id}", response_model=ShadowAuditView)
async def get_shadow_audit(
    audit_id: uuid.UUID,
    user: CurrentUserDep,
) -> ShadowAuditView:
    view = await shadow_audit_repository.get_by_audit_id(
        audit_id,
        organization_id=user.organization_id,
    )
    if view is None:
        raise HTTPException(status_code=404, detail="Shadow audit not found")
    return view


@router.get(
    "/executions/{execution_id}/shadow-audit",
    response_model=list[ShadowAuditView],
)
async def get_execution_shadow_audits(
    execution_id: uuid.UUID,
    user: CurrentUserDep,
) -> list[ShadowAuditView]:
    return await shadow_audit_repository.get_by_execution_id(
        execution_id,
        organization_id=user.organization_id,
    )


__all__ = ["router"]
