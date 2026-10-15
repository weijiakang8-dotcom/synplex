from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from langgraph.checkpoint.base import Checkpoint
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.config import settings


def _psycopg_url(database_url: str) -> str:
    """AsyncPostgresSaver 使用 psycopg，需去掉 +asyncpg 驱动后缀。"""
    return database_url.replace("postgresql+asyncpg://", "postgresql://")


class CheckpointManager:
    """LangGraph 状态在 PostgreSQL 中的持久化管理器。"""

    def __init__(self, saver: AsyncPostgresSaver) -> None:
        self.saver = saver

    @staticmethod
    def _config(thread_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}

    async def save_checkpoint(
        self, thread_id: str, state: dict[str, Any]
    ) -> dict[str, Any]:
        config = self._config(thread_id)
        version = 1
        checkpoint: Checkpoint = {
            "v": 1,
            "id": uuid.uuid4().hex,
            "ts": datetime.now(timezone.utc).isoformat(),
            "channel_values": {"state": state},
            "channel_versions": {"state": version},
            "versions_seen": {},
            "updated_channels": {},
        }
        await self.saver.aput(
            config, checkpoint, metadata={}, new_versions={"state": version}
        )
        return config

    async def load_checkpoint(self, thread_id: str) -> dict[str, Any] | None:
        checkpoint_tuple = await self.saver.aget_tuple(self._config(thread_id))
        if checkpoint_tuple is None or checkpoint_tuple.checkpoint is None:
            return None
        return checkpoint_tuple.checkpoint.get("channel_values", {}).get("state")


@asynccontextmanager
async def get_checkpoint_manager() -> AsyncIterator[CheckpointManager]:
    async with AsyncPostgresSaver.from_conn_string(
        _psycopg_url(settings.DATABASE_URL)
    ) as saver:
        async with asyncio.timeout(20):
            await saver.setup()
        yield CheckpointManager(saver)
