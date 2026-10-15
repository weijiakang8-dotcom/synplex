from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.permissions import require_permission
from app.models import AuditLog

router = APIRouter(prefix="/audit-logs", tags=["audit-logs"])


@router.get("", dependencies=[Depends(require_permission("audit:view"))])
async def list_audit_logs(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(200)
    if user.organization_id is not None:
        stmt = stmt.where(AuditLog.organization_id == user.organization_id)
    result = await session.execute(stmt)
    return [
        {
            "id": str(log.id),
            "user_id": str(log.user_id) if log.user_id else None,
            "organization_id": (
                str(log.organization_id) if log.organization_id else None
            ),
            "action": log.action,
            "resource_type": log.resource_type,
            "resource_id": log.resource_id,
            "ip_address": log.ip_address,
            "method": log.method,
            "path": log.path,
            "status_code": log.status_code,
            "details": log.details,
            "created_at": log.created_at.isoformat(),
        }
        for log in result.scalars().all()
    ]
