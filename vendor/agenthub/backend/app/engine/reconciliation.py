"""Phase 6B：PENDING / tool_call 对账与 checkpoint 保留清理。

原则：
- 绝不因清扫自动重放 UNKNOWN 副作用；
- 无法安全判断的记录 fail-closed + 审计，留人工；
- 所有状态变更 CAS + audit，幂等；
- 不删除真实业务数据。
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, update

from app.config import settings
from app.database import async_session_factory
from app.engine.executor import audit_execution_event
from app.models import AuditLog, Execution, ToolCall
from app.models.enums import ExecutionStatus, ToolCallStatus

logger = logging.getLogger(__name__)


async def reconcile_stale_pending_executions() -> dict[str, int]:
    """把超时且从未开始的 PENDING Execution 收敛为 FAILED（CAS + audit）。"""
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=settings.RECONCILE_PENDING_EXECUTION_MINUTES
    )
    reconciled = 0
    async with async_session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(Execution).where(
                        Execution.status == ExecutionStatus.PENDING,
                        Execution.updated_at < cutoff,
                    )
                )
            )
            .scalars()
            .all()
        )
        for execution in rows:
            result = await session.execute(
                update(Execution)
                .where(
                    Execution.id == execution.id,
                    Execution.status == ExecutionStatus.PENDING,
                )
                .values(
                    status=ExecutionStatus.FAILED,
                    error_message="reconciled: pending execution never started",
                    completed_at=datetime.now(timezone.utc),
                )
                .returning(Execution.id)
            )
            if result.scalar_one_or_none() is None:
                continue
            reconciled += 1
            await audit_execution_event(
                execution_id=str(execution.id),
                action="execution_reconciled",
                organization_id=execution.organization_id,
                user_id=execution.user_id,
                details={"reason": "pending never started"},
            )
        await session.commit()
    return {"reconciled": reconciled}


async def reconcile_stale_waiting_approvals() -> dict[str, int]:
    """悬挂审批超时收敛：WAITING_FOR_APPROVAL 超过阈值 → FAILED + audit（CAS 幂等）。"""
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=settings.RECONCILE_APPROVAL_MINUTES
    )
    reconciled = 0
    async with async_session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(Execution).where(
                        Execution.status == ExecutionStatus.WAITING_FOR_APPROVAL,
                        Execution.updated_at < cutoff,
                    )
                )
            )
            .scalars()
            .all()
        )
        for execution in rows:
            result = await session.execute(
                update(Execution)
                .where(
                    Execution.id == execution.id,
                    Execution.status == ExecutionStatus.WAITING_FOR_APPROVAL,
                )
                .values(
                    status=ExecutionStatus.FAILED,
                    error_message="reconciled: approval timed out",
                    completed_at=datetime.now(timezone.utc),
                )
                .returning(Execution.id)
            )
            if result.scalar_one_or_none() is None:
                continue
            reconciled += 1
            await audit_execution_event(
                execution_id=str(execution.id),
                action="approval_timeout_reconciled",
                organization_id=execution.organization_id,
                user_id=execution.user_id,
                details={"reason": "waiting_for_approval timed out"},
            )
        await session.commit()
    return {"reconciled": reconciled}


async def reconcile_tool_calls() -> dict[str, int]:
    """tool_call 对账：
    - 孤儿 PENDING（带 key、所属 execution 已终止、超时）→ FAILED + audit（绝不执行）；
    - IN_FLIGHT 超时 → 保持 IN_FLIGHT + audit side_effect_unknown_reconciled（人工）；
    - 历史无 key PENDING → 保持 + audit tool_call_manual_required（人工）。
    """
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=settings.RECONCILE_TOOLCALL_MINUTES
    )
    result: dict[str, int] = {
        "orphan_failed": 0,
        "unknown_flagged": 0,
        "manual_flagged": 0,
    }
    async with async_session_factory() as session:
        calls = (
            (
                await session.execute(
                    select(ToolCall).where(
                        ToolCall.status.in_(
                            [ToolCallStatus.PENDING, ToolCallStatus.IN_FLIGHT]
                        ),
                        ToolCall.updated_at < cutoff,
                    )
                )
            )
            .scalars()
            .all()
        )
        for call in calls:
            execution = await session.get(Execution, call.execution_id)
            if call.status == ToolCallStatus.IN_FLIGHT:
                if not await _audit_exists(
                    session,
                    action="side_effect_unknown_reconciled",
                    execution_id=call.execution_id,
                    tool_call_id=call.id,
                ):
                    result["unknown_flagged"] += 1
                    await audit_execution_event(
                        execution_id=str(call.execution_id),
                        action="side_effect_unknown_reconciled",
                        organization_id=call.organization_id,
                        user_id=execution.user_id if execution else None,
                        details={
                            "tool_call_id": str(call.id),
                            "reason": "IN_FLIGHT older than cutoff; fail-closed, manual",
                        },
                    )
                continue
            if not call.idempotency_key:
                if not await _audit_exists(
                    session,
                    action="tool_call_manual_required",
                    execution_id=call.execution_id,
                    tool_call_id=call.id,
                ):
                    result["manual_flagged"] += 1
                    await audit_execution_event(
                        execution_id=str(call.execution_id),
                        action="tool_call_manual_required",
                        organization_id=call.organization_id,
                        user_id=execution.user_id if execution else None,
                        details={
                            "tool_call_id": str(call.id),
                            "reason": "legacy PENDING without idempotency key",
                        },
                    )
                continue
            if execution is None or execution.status in {
                ExecutionStatus.COMPLETED,
                ExecutionStatus.FAILED,
                ExecutionStatus.ROLLED_BACK,
            }:
                claimed = await session.execute(
                    update(ToolCall)
                    .where(
                        ToolCall.id == call.id,
                        ToolCall.status == ToolCallStatus.PENDING,
                    )
                    .values(
                        status=ToolCallStatus.FAILED,
                        completed_at=datetime.now(timezone.utc),
                        output_result={
                            "status": "failed",
                            "data": None,
                            "error": "reconciled: orphan pending, never executed",
                        },
                    )
                    .returning(ToolCall.id)
                )
                if claimed.scalar_one_or_none() is None:
                    continue
                result["orphan_failed"] += 1
                await audit_execution_event(
                    execution_id=str(call.execution_id),
                    action="tool_call_reconciled",
                    organization_id=call.organization_id,
                    user_id=execution.user_id if execution else None,
                    details={
                        "tool_call_id": str(call.id),
                        "reason": "orphan pending on terminal execution",
                    },
                )
        await session.commit()
    return result


async def _audit_exists(
    session: Any,
    *,
    action: str,
    execution_id: uuid.UUID,
    tool_call_id: uuid.UUID,
) -> bool:
    """确定性审计去重：同一 tool_call 的同一动作只写一次（reconcile 幂等）。"""
    row = await session.execute(
        select(AuditLog.id)
        .where(
            AuditLog.action == action,
            AuditLog.resource_id == str(execution_id),
            AuditLog.details["tool_call_id"].as_string() == str(tool_call_id),
        )
        .limit(1)
    )
    return row.scalar_one_or_none() is not None


async def cleanup_old_checkpoints(*, dry_run: bool = False) -> dict[str, Any]:
    """只清理已终止且超过保留期的 execution 的 checkpoint（可重复、可审计）。"""
    retention = datetime.now(timezone.utc) - timedelta(
        days=settings.CHECKPOINT_RETENTION_DAYS
    )
    async with async_session_factory() as session:
        terminal = (
            (
                await session.execute(
                    select(Execution).where(
                        Execution.status.in_(
                            [
                                ExecutionStatus.COMPLETED,
                                ExecutionStatus.FAILED,
                                ExecutionStatus.ROLLED_BACK,
                            ]
                        ),
                        Execution.completed_at.is_not(None),
                        Execution.completed_at < retention,
                    )
                )
            )
            .scalars()
            .all()
        )
        thread_ids = [str(execution.id) for execution in terminal]
        before = {
            table: await _count_thread_rows(session, table, thread_ids)
            for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints")
        }
        removed = {table: 0 for table in before}
        if not dry_run and thread_ids:
            removed["checkpoint_writes"] = await _delete_thread_rows(
                session, "checkpoint_writes", thread_ids
            )
            removed["checkpoint_blobs"] = await _delete_thread_rows(
                session, "checkpoint_blobs", thread_ids
            )
            removed["checkpoints"] = await _delete_thread_rows(
                session, "checkpoints", thread_ids
            )
            await session.commit()
            await audit_execution_event(
                execution_id="system",
                action="checkpoint_cleanup",
                organization_id=None,
                user_id=None,
                details={
                    "before": before,
                    "removed": removed,
                    "executions": len(thread_ids),
                    "retention_days": settings.CHECKPOINT_RETENTION_DAYS,
                },
            )
    return {"before": before, "removed": removed, "executions": len(thread_ids)}


async def _count_thread_rows(session, table: str, thread_ids: list[str]) -> int:
    if not thread_ids:
        return 0
    from sqlalchemy import text

    return int(
        (
            await session.execute(
                text(f"SELECT count(*) FROM {table} WHERE thread_id = ANY(:ids)"),
                {"ids": thread_ids},
            )
        ).scalar()
        or 0
    )


async def _delete_thread_rows(session, table: str, thread_ids: list[str]) -> int:
    from sqlalchemy import text

    result = await session.execute(
        text(f"DELETE FROM {table} WHERE thread_id = ANY(:ids)"),
        {"ids": thread_ids},
    )
    return result.rowcount or 0


__all__ = [
    "cleanup_old_checkpoints",
    "reconcile_stale_pending_executions",
    "reconcile_tool_calls",
]
