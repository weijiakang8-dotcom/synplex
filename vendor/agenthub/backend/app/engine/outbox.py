from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select

from app.models import OutboxEvent, utcnow


async def enqueue_outbox_event(
    session,
    event_type: str,
    payload: dict[str, Any],
    *,
    execution_id: uuid.UUID | None = None,
) -> OutboxEvent:
    event = OutboxEvent(
        execution_id=execution_id,
        event_type=event_type,
        payload=payload,
        attempt_count=0,
        available_at=utcnow(),
    )
    session.add(event)
    await session.flush()
    return event


async def dispatch_outbox_batch(
    session, publishers: dict[str, Any], limit: int = 100
) -> dict[str, int]:
    events = list(
        (
            await session.execute(
                select(OutboxEvent)
                .where(
                    OutboxEvent.published_at.is_(None),
                    OutboxEvent.available_at <= utcnow(),
                )
                .order_by(OutboxEvent.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    published = 0
    failed = 0
    for event in events:
        publisher = publishers.get(event.event_type)
        if publisher is None:
            event.attempt_count += 1
            event.last_error = f"unsupported outbox event: {event.event_type}"
            event.available_at = utcnow() + timedelta(minutes=5)
            failed += 1
            continue
        try:
            publisher(**event.payload)
            event.published_at = utcnow()
            event.last_error = None
            published += 1
        except Exception as exc:  # noqa: BLE001
            event.attempt_count += 1
            event.last_error = str(exc)[:1000]
            delay = min(300, 2 ** min(event.attempt_count, 8))
            event.available_at = utcnow() + timedelta(seconds=delay)
            failed += 1
    await session.commit()
    return {"published": published, "failed": failed}
