from __future__ import annotations

import uuid

from sqlalchemy import func, select

from app.database import async_session_factory
from app.models import ShadowAuditRecord
from app.schemas.shadow_audit import ShadowAuditView


def _to_view(record: ShadowAuditRecord) -> ShadowAuditView:
    return ShadowAuditView(
        audit_id=record.id,
        execution_id=record.execution_id,
        workflow_id=record.workflow_id,
        shadow_status=record.shadow_status,
        kernel_termination=record.kernel_termination,
        kernel_goal_status=record.kernel_goal_status,
        evidence_level=record.evidence_level,
        semantic_match=record.semantic_match,
        information_loss=record.information_loss or [],
        violations=record.violations or [],
        trace=record.trace or [],
        error_type=record.error_type,
        error_message=record.error_message,
        created_at=record.created_at,
    )


async def get_by_audit_id(
    audit_id: uuid.UUID,
    organization_id: uuid.UUID | None = None,
) -> ShadowAuditView | None:
    async with async_session_factory() as session:
        record = await session.get(ShadowAuditRecord, audit_id)
        if (
            record is not None
            and organization_id is not None
            and record.organization_id != organization_id
        ):
            return None
        return _to_view(record) if record is not None else None


async def get_by_execution_id(
    execution_id: uuid.UUID,
    organization_id: uuid.UUID | None = None,
) -> list[ShadowAuditView]:
    async with async_session_factory() as session:
        stmt = select(ShadowAuditRecord).where(
            ShadowAuditRecord.execution_id == execution_id
        )
        if organization_id is not None:
            stmt = stmt.where(ShadowAuditRecord.organization_id == organization_id)
        stmt = stmt.order_by(
            ShadowAuditRecord.created_at.desc(),
            ShadowAuditRecord.id.desc(),
        )
        result = await session.execute(stmt)
        return [_to_view(record) for record in result.scalars().all()]


async def list_recent(
    *,
    limit: int = 20,
    offset: int = 0,
    shadow_status: str | None = None,
    kernel_goal_status: str | None = None,
    execution_id: uuid.UUID | None = None,
    workflow_id: uuid.UUID | None = None,
    organization_id: uuid.UUID | None = None,
) -> list[ShadowAuditView]:
    limit = min(max(limit, 1), 100)
    offset = max(offset, 0)
    async with async_session_factory() as session:
        stmt = select(ShadowAuditRecord)
        if shadow_status is not None:
            stmt = stmt.where(ShadowAuditRecord.shadow_status == shadow_status)
        if kernel_goal_status is not None:
            stmt = stmt.where(
                ShadowAuditRecord.kernel_goal_status == kernel_goal_status
            )
        if execution_id is not None:
            stmt = stmt.where(ShadowAuditRecord.execution_id == execution_id)
        if workflow_id is not None:
            stmt = stmt.where(ShadowAuditRecord.workflow_id == workflow_id)
        if organization_id is not None:
            stmt = stmt.where(ShadowAuditRecord.organization_id == organization_id)
        stmt = (
            stmt.order_by(
                ShadowAuditRecord.created_at.desc(),
                ShadowAuditRecord.id.desc(),
            )
            .offset(offset)
            .limit(limit)
        )
        result = await session.execute(stmt)
        return [_to_view(record) for record in result.scalars().all()]


async def stats(organization_id: uuid.UUID | None = None) -> dict:
    async with async_session_factory() as session:

        async def _count(*conditions) -> int:
            stmt = select(func.count()).select_from(ShadowAuditRecord)
            if organization_id is not None:
                stmt = stmt.where(ShadowAuditRecord.organization_id == organization_id)
            for condition in conditions:
                stmt = stmt.where(condition)
            result = await session.execute(stmt)
            return int(result.scalar_one() or 0)

        return {
            "total": await _count(),
            "success": await _count(ShadowAuditRecord.shadow_status == "SUCCESS"),
            "failed": await _count(ShadowAuditRecord.shadow_status == "FAILED"),
            "disabled": await _count(ShadowAuditRecord.shadow_status == "DISABLED"),
            "goal_satisfied": await _count(
                ShadowAuditRecord.kernel_goal_status == "SATISFIED"
            ),
            "goal_not_satisfied": await _count(
                ShadowAuditRecord.kernel_goal_status == "NOT_SATISFIED"
            ),
            "semantic_match_count": await _count(
                ShadowAuditRecord.semantic_match.is_(True)
            ),
            "violation_count": await _count(
                func.json_array_length(ShadowAuditRecord.violations) > 0
            ),
        }


__all__ = [
    "get_by_audit_id",
    "get_by_execution_id",
    "list_recent",
    "stats",
]
