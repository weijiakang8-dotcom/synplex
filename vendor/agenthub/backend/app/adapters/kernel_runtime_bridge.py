from __future__ import annotations

import uuid

from sqlalchemy import update

from app.database import async_session_factory
from app.engine.event_bus import publish_execution_event
from app.kernel.goal.result import GoalStatus
from app.kernel.runtime.model import TerminationReason
from app.models import AuditLog, Execution, utcnow
from app.models.enums import ExecutionStatus


def _execution_status(output) -> ExecutionStatus:
    if (
        output.goal_result.status == GoalStatus.SATISFIED
        and output.termination_reason == TerminationReason.TERMINATED_GOAL_SATISFIED
    ):
        return ExecutionStatus.COMPLETED
    return ExecutionStatus.FAILED


async def persist_kernel_output(execution_id: uuid.UUID, output) -> None:
    """将 RuntimeOutput 映射到现有 Execution/Audit/Event 持久化契约。"""
    status = _execution_status(output)
    error = output.error
    if status == ExecutionStatus.FAILED and not error:
        error = f"kernel termination: {output.termination_reason.value}"

    payload = output.model_dump(mode="json")
    terminal_states = (
        ExecutionStatus.COMPLETED,
        ExecutionStatus.FAILED,
        ExecutionStatus.ROLLED_BACK,
    )
    async with async_session_factory() as session:
        result = await session.execute(
            update(Execution)
            .where(
                Execution.id == execution_id,
                Execution.status.notin_(terminal_states),
            )
            .values(
                status=status,
                final_output=None,
                error_message=error or None,
                completed_at=utcnow(),
                checkpoint_data={"kernel_runtime_output": payload},
                steps=[
                    {"task_id": task_id, "capability_id": entry.capability_id}
                    for task_id, entry in zip(
                        output.applied_tasks, output.execution_trace
                    )
                ],
            )
            .returning(Execution.id, Execution.organization_id)
        )
        returned = result.first()
        if returned is None:
            await session.rollback()
            return
        _, organization_id = returned

        session.add(
            AuditLog(
                organization_id=organization_id,
                user_id=None,
                method="KERNEL",
                path="/kernel/runtime",
                status_code=200 if status == ExecutionStatus.COMPLETED else 500,
                action="kernel_execution",
                resource_type="execution",
                resource_id=str(execution_id),
                details=payload,
            )
        )
        await session.commit()

    event = (
        "execution_completed"
        if status == ExecutionStatus.COMPLETED
        else "execution_failed"
    )
    await publish_execution_event(
        str(execution_id),
        {
            "event": event,
            "runtime": "kernel",
            "termination_reason": output.termination_reason.value,
            "goal_status": output.goal_result.status.value,
            "error": error or None,
        },
    )


async def persist_unsupported_workflow(
    execution_id: uuid.UUID,
    reason: str,
) -> None:
    """Kernel mode 不支持的工作流必须明确失败，不 fallback legacy。"""
    terminal_states = (
        ExecutionStatus.COMPLETED,
        ExecutionStatus.FAILED,
        ExecutionStatus.ROLLED_BACK,
    )
    async with async_session_factory() as session:
        result = await session.execute(
            update(Execution)
            .where(
                Execution.id == execution_id,
                Execution.status.notin_(terminal_states),
            )
            .values(
                status=ExecutionStatus.FAILED,
                error_message=f"NOT_SUPPORTED_IN_KERNEL_MODE: {reason}",
                completed_at=utcnow(),
            )
            .returning(Execution.id, Execution.organization_id)
        )
        returned = result.first()
        if returned is None:
            await session.rollback()
            return
        _, organization_id = returned

        session.add(
            AuditLog(
                organization_id=organization_id,
                user_id=None,
                method="KERNEL",
                path="/kernel/runtime",
                status_code=501,
                action="kernel_unsupported",
                resource_type="execution",
                resource_id=str(execution_id),
                details={"reason": reason},
            )
        )
        await session.commit()

    await publish_execution_event(
        str(execution_id),
        {
            "event": "execution_failed",
            "runtime": "kernel",
            "error": f"NOT_SUPPORTED_IN_KERNEL_MODE: {reason}",
        },
    )


__all__ = ["persist_kernel_output", "persist_unsupported_workflow"]
