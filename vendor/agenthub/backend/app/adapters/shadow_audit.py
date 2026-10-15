from __future__ import annotations

import uuid

from app.adapters.runtime_bridge import ShadowExecutionResult
from app.database import async_session_factory
from app.models import ShadowAuditRecord


def to_audit_record(
    result: ShadowExecutionResult,
    *,
    execution_id: str,
    workflow_id: str | None,
    organization_id: str | None = None,
) -> ShadowAuditRecord:
    """把 ShadowExecutionResult 转换为可持久化的 ShadowAuditRecord（纯函数）。"""
    return ShadowAuditRecord(
        execution_id=uuid.UUID(execution_id),
        workflow_id=uuid.UUID(workflow_id) if workflow_id else None,
        organization_id=uuid.UUID(organization_id) if organization_id else None,
        shadow_status=result.shadow_status,
        kernel_termination=result.kernel_termination,
        kernel_goal_status=result.kernel_goal_status,
        evidence_level=result.evidence_level,
        semantic_match=result.semantic_match,
        information_loss=result.information_loss,
        violations=result.violations,
        trace=result.trace,
        error_type=result.error_type,
        error_message=result.error_message,
    )


async def persist_shadow_audit(
    result: ShadowExecutionResult,
    *,
    execution_id: str,
    workflow_id: str | None,
    organization_id: str | None = None,
) -> ShadowAuditRecord | None:
    """旁路审计持久化：独立 Session，失败不影响 Legacy。"""
    try:
        record = to_audit_record(
            result,
            execution_id=execution_id,
            workflow_id=workflow_id,
            organization_id=organization_id,
        )
        async with async_session_factory() as session:
            session.add(record)
            await session.commit()
        return record
    except Exception:  # noqa: BLE001
        return None


__all__ = ["ShadowAuditRecord", "persist_shadow_audit", "to_audit_record"]
