from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from app.database import async_session_factory
from app.engine.cancellation import ensure_execution_active
from app.engine.execution_state import (
    LEASE_DURATION,
    acquire_execution_lease,
    heartbeat_execution_lease,
    release_execution_lease,
)


class ExecutionLeaseUnavailable(RuntimeError):
    pass


async def run_with_execution_lease(
    execution_id: uuid.UUID,
    owner: str,
    run: Callable[[], Awaitable[None]],
) -> None:
    async with async_session_factory() as session:
        acquired = await acquire_execution_lease(session, execution_id, owner)
        await session.commit()
    if not acquired:
        raise ExecutionLeaseUnavailable(f"execution lease unavailable: {execution_id}")

    stop = asyncio.Event()

    async def heartbeat() -> None:
        interval = max(1.0, LEASE_DURATION.total_seconds() / 3)
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except TimeoutError:
                async with async_session_factory() as session:
                    alive = await heartbeat_execution_lease(
                        session, execution_id, owner
                    )
                    await session.commit()
                if not alive:
                    stop.set()
                    return

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        await ensure_execution_active(execution_id)
        await run()
    finally:
        stop.set()
        await heartbeat_task
        async with async_session_factory() as session:
            await release_execution_lease(session, execution_id, owner)
            await session.commit()
