from __future__ import annotations

import asyncio
import uuid

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.api.deps import CurrentUserWsDep
from app.config import settings
from app.database import master_session_factory
from app.engine.event_bus import CHANNEL_PREFIX
from app.models import Execution, ExecutionEvent, ToolCall, User

router = APIRouter()


async def _execution_status(execution_id: uuid.UUID, user: User) -> dict:
    async with master_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is None:
            return {"event": "not_found", "execution_id": str(execution_id)}
        if (
            user.organization_id is not None
            and execution.organization_id != user.organization_id
        ):
            return {"event": "forbidden", "execution_id": str(execution_id)}
        tool_calls = (
            (
                await session.execute(
                    select(ToolCall)
                    .where(ToolCall.execution_id == execution_id)
                    .order_by(ToolCall.started_at)
                )
            )
            .scalars()
            .all()
        )
        return {
            "event": "status",
            "execution_id": str(execution_id),
            "status": execution.status.value,
            "current_step_index": execution.current_step_index,
            "final_output": execution.final_output,
            "error_message": execution.error_message,
            "tool_calls": [
                {
                    "id": str(tc.id),
                    "tool_name": tc.tool_name,
                    "status": tc.status.value,
                    "input_params": tc.input_params,
                    "output_result": tc.output_result,
                    "started_at": tc.started_at.isoformat() if tc.started_at else None,
                    "completed_at": (
                        tc.completed_at.isoformat() if tc.completed_at else None
                    ),
                }
                for tc in tool_calls
            ],
        }


@router.websocket("/ws/executions/{execution_id}")
async def execution_websocket(
    websocket: WebSocket,
    execution_id: uuid.UUID,
    user: CurrentUserWsDep,
) -> None:
    await websocket.accept()

    redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = redis.pubsub()
    await pubsub.subscribe(f"{CHANNEL_PREFIX}{execution_id}")

    try:
        after_sequence = max(0, int(websocket.query_params.get("after_sequence", "0")))
    except ValueError:
        after_sequence = 0
    async with master_session_factory() as session:
        historical = list(
            (
                await session.execute(
                    select(ExecutionEvent)
                    .where(
                        ExecutionEvent.execution_id == execution_id,
                        ExecutionEvent.sequence > after_sequence,
                    )
                    .order_by(ExecutionEvent.sequence)
                )
            ).scalars()
        )
    for event in historical:
        await websocket.send_json(event.payload)

    try:
        while True:
            status = await _execution_status(execution_id, user)
            await websocket.send_json(status)

            if status.get("event") in {"not_found", "forbidden"}:
                break
            if status.get("status") in {"completed", "failed", "rolled_back"}:
                break

            try:
                message = await asyncio.wait_for(
                    pubsub.get_message(timeout=1), timeout=1.05
                )
            except asyncio.TimeoutError:
                continue

            if message and message.get("type") == "message":
                await websocket.send_text(message["data"])

    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(f"{CHANNEL_PREFIX}{execution_id}")
        await pubsub.aclose()
        await redis.aclose()
