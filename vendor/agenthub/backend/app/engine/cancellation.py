from __future__ import annotations

import uuid

from app.database import async_session_factory
from app.models import Execution
from app.models.enums import ExecutionStatus


class ExecutionCancelled(RuntimeError):
    pass


async def ensure_execution_active(execution_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is None:
            raise ExecutionCancelled("execution no longer exists")
        if execution.status != ExecutionStatus.RUNNING:
            raise ExecutionCancelled(
                f"execution is no longer active: {execution.status.value}"
            )
