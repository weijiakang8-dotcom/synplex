from __future__ import annotations

import json
import logging
import time
import uuid as uuid_module
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import select, update

from app.config import settings
from app.database import async_session_factory
from app.models import Execution, ExecutionEvent

logger = logging.getLogger(__name__)

CHANNEL_PREFIX = "agenthub:execution:"
_STREAM_EVENTS = frozenset({"token"})


def _channel(execution_id: str) -> str:
    return f"{CHANNEL_PREFIX}{execution_id}"


async def publish_execution_event(execution_id: str, event: dict[str, Any]) -> None:
    event_name = str(event.get("event") or "")
    is_stream_event = event_name in _STREAM_EVENTS
    correlation_id = None
    sequence = None

    try:
        execution_uuid = uuid_module.UUID(str(execution_id))
    except (ValueError, TypeError):
        execution_uuid = None

    if execution_uuid is not None:
        try:
            async with async_session_factory() as session:
                if is_stream_event:
                    correlation_id = await session.scalar(
                        select(Execution.correlation_id).where(
                            Execution.id == execution_uuid
                        )
                    )
                else:
                    result = await session.execute(
                        update(Execution)
                        .where(Execution.id == execution_uuid)
                        .values(event_sequence=Execution.event_sequence + 1)
                        .returning(
                            Execution.event_sequence,
                            Execution.correlation_id,
                        )
                    )
                    row = result.first()
                    if row is not None:
                        sequence = int(row.event_sequence)
                        correlation_id = row.correlation_id
                        event_id = str(uuid_module.uuid4())
                        payload = {
                            "event_id": event_id,
                            "execution_id": execution_id,
                            "correlation_id": (
                                str(correlation_id) if correlation_id else None
                            ),
                            "sequence": sequence,
                            "ts": time.time_ns(),
                            **event,
                        }
                        session.add(
                            ExecutionEvent(
                                id=uuid_module.UUID(event_id),
                                execution_id=execution_uuid,
                                sequence=sequence,
                                payload=payload,
                            )
                        )
                await session.commit()
        except Exception:
            logger.warning(
                "Failed to allocate execution event metadata",
                exc_info=True,
            )

    if "event_id" not in locals():
        event_id = str(uuid_module.uuid4())
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        try:
            payload = {
                "event_id": event_id,
                "execution_id": execution_id,
                "correlation_id": str(correlation_id) if correlation_id else None,
                "sequence": sequence,
                "ts": time.time_ns(),
                **event,
            }
            await client.publish(
                _channel(execution_id),
                json.dumps(payload, ensure_ascii=False, default=str),
            )
        except Exception:
            logger.warning(
                "Failed to publish execution event; event not delivered",
                exc_info=True,
            )
    finally:
        try:
            await client.aclose()
        except Exception:
            logger.debug("Failed to close Redis event client", exc_info=True)
