import json
import uuid
from typing import Annotated

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_admin_api_key_user
from app.config import settings
from app.database import master_session_factory
from app.engine.tasks import execute_workflow_task
from app.models import Execution, User
from app.models.enums import ExecutionStatus

router = APIRouter(prefix="/tasks", tags=["tasks"])
DLQ_KEY = "dead_letter_queue"
AdminUserDep = Annotated[User, Depends(get_admin_api_key_user)]


@router.get("/queues")
async def queues(_admin: AdminUserDep) -> dict:
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        celery_len = await client.llen("celery")
        dlq_len = await client.llen(DLQ_KEY)
        return {"celery": celery_len, "dead_letter_queue": dlq_len}
    finally:
        await client.aclose()


@router.get("/failed")
async def failed(_admin: AdminUserDep, limit: int = 100) -> list[dict]:
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        items = await client.lrange(DLQ_KEY, 0, limit - 1)
        parsed = []
        for item in items:
            try:
                parsed.append(json.loads(item))
            except json.JSONDecodeError:
                continue
        return parsed
    finally:
        await client.aclose()


@router.post("/{execution_id}/retry")
async def retry(execution_id: str, _admin: AdminUserDep) -> dict:
    try:
        execution_uuid = uuid.UUID(execution_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid execution id")

    async with master_session_factory() as session:
        execution = await session.get(Execution, execution_uuid)
        if execution is None:
            raise HTTPException(status_code=404, detail="Execution not found")
        if execution.status in {
            ExecutionStatus.PENDING,
            ExecutionStatus.RUNNING,
            ExecutionStatus.WAITING_FOR_APPROVAL,
            ExecutionStatus.COMPLETED,
        }:
            raise HTTPException(
                status_code=409,
                detail=f"Execution cannot be retried in status {execution.status.value}",
            )
        execution.status = ExecutionStatus.PENDING
        execution.current_step_index = 0
        execution.error_message = None
        await session.commit()

    execute_workflow_task.delay(execution_id)
    return {"status": "requeued", "execution_id": execution_id}
