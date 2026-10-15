from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import update

from app.models import Execution, utcnow
from app.models.enums import ExecutionStatus

LEASE_DURATION = timedelta(minutes=5)

ALLOWED_TRANSITIONS: dict[ExecutionStatus, set[ExecutionStatus]] = {
    ExecutionStatus.PENDING: {ExecutionStatus.RUNNING, ExecutionStatus.FAILED},
    ExecutionStatus.RUNNING: {
        ExecutionStatus.WAITING_FOR_APPROVAL,
        ExecutionStatus.COMPLETED,
        ExecutionStatus.FAILED,
    },
    ExecutionStatus.WAITING_FOR_APPROVAL: {
        ExecutionStatus.RUNNING,
        ExecutionStatus.FAILED,
    },
    ExecutionStatus.COMPLETED: set(),
    ExecutionStatus.FAILED: set(),
    ExecutionStatus.ROLLED_BACK: set(),
}


class InvalidExecutionTransition(ValueError):
    pass


async def transition_execution(
    session,
    execution_id: uuid.UUID,
    expected: ExecutionStatus,
    target: ExecutionStatus,
    **values,
) -> bool:
    if target not in ALLOWED_TRANSITIONS.get(expected, set()):
        raise InvalidExecutionTransition(
            f"{expected.value} -> {target.value} is not allowed"
        )
    result = await session.execute(
        update(Execution)
        .where(Execution.id == execution_id, Execution.status == expected)
        .values(status=target, updated_at=utcnow(), **values)
    )
    return (result.rowcount or 0) == 1


async def acquire_execution_lease(
    session,
    execution_id: uuid.UUID,
    owner: str,
    *,
    duration: timedelta = LEASE_DURATION,
) -> bool:
    now = utcnow()
    result = await session.execute(
        update(Execution)
        .where(
            Execution.id == execution_id,
            Execution.status.in_({ExecutionStatus.PENDING, ExecutionStatus.RUNNING}),
            (Execution.lease_expires_at.is_(None)) | (Execution.lease_expires_at < now),
        )
        .values(
            status=ExecutionStatus.RUNNING,
            lease_owner=owner,
            lease_expires_at=now + duration,
            heartbeat_at=now,
            run_attempt=Execution.run_attempt + 1,
            updated_at=now,
        )
    )
    return (result.rowcount or 0) == 1


async def heartbeat_execution_lease(
    session,
    execution_id: uuid.UUID,
    owner: str,
    *,
    duration: timedelta = LEASE_DURATION,
) -> bool:
    now = utcnow()
    result = await session.execute(
        update(Execution)
        .where(
            Execution.id == execution_id,
            Execution.status == ExecutionStatus.RUNNING,
            Execution.lease_owner == owner,
            Execution.lease_expires_at > now,
        )
        .values(heartbeat_at=now, lease_expires_at=now + duration, updated_at=now)
    )
    return (result.rowcount or 0) == 1


async def release_execution_lease(session, execution_id: uuid.UUID, owner: str) -> bool:
    result = await session.execute(
        update(Execution)
        .where(Execution.id == execution_id, Execution.lease_owner == owner)
        .values(lease_owner=None, lease_expires_at=None, heartbeat_at=utcnow())
    )
    return (result.rowcount or 0) == 1
