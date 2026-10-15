"""Phase 6B：DLQ 生命周期（stats / 人工 replay / discard）。

规则：
- 自动策略不存在；只有显式人工 replay / discard；
- replay 仅允许 execution 处于 PENDING/RUNNING；终止态 → skip + audit；
- 副作用失败 / UNKNOWN 禁止自动 replay；
- 不允许无限重试；不允许通过 replay 绕过 Approval。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

import redis.asyncio as aioredis

from app.config import settings
from app.database import async_session_factory
from app.engine.executor import audit_execution_event
from app.models import Execution
from app.models.enums import ExecutionStatus

logger = logging.getLogger(__name__)

DLQ_KEY = "dead_letter_queue"


async def _redis() -> aioredis.Redis:
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


async def dlq_stats() -> dict[str, Any]:
    client = await _redis()
    try:
        entries = await client.lrange(DLQ_KEY, 0, -1)
    finally:
        await client.aclose()
    parsed: list[dict[str, Any]] = []
    error_counts: dict[str, int] = {}
    for raw in entries:
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            item = {"error": "unparseable"}
        error = str(item.get("error") or "unknown")
        error_counts[error] = error_counts.get(error, 0) + 1
        parsed.append(
            {
                "execution_id": item.get("execution_id"),
                "error": error,
                "task": item.get("task"),
            }
        )
    return {"count": len(parsed), "by_error": error_counts, "entries": parsed}


async def dlq_replay(index: int, *, actor: str = "cli") -> dict[str, Any]:
    """安全人工 replay：仅 PENDING/RUNNING execution 才重新入队。"""
    client = await _redis()
    try:
        raw = await client.lindex(DLQ_KEY, index)
    finally:
        await client.aclose()
    if raw is None:
        return {"ok": False, "reason": "index out of range"}
    try:
        entry = json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "reason": "unparseable entry"}

    execution_id = entry.get("execution_id")
    if not execution_id:
        return {"ok": False, "reason": "missing execution_id"}
    async with async_session_factory() as session:
        execution = await session.get(Execution, uuid.UUID(str(execution_id)))
        status = execution.status if execution is not None else None
    if status not in {
        ExecutionStatus.PENDING,
        ExecutionStatus.RUNNING,
    }:
        await audit_execution_event(
            execution_id=str(execution_id),
            action="dlq_replay_skipped",
            user_id=None,
            details={"actor": actor, "reason": f"status={status} not replayable"},
        )
        return {
            "ok": False,
            "reason": "execution not replayable",
            "status": status.value if status else None,
        }

    from app.engine.tasks import execute_workflow_task

    execute_workflow_task.delay(str(execution_id))
    await audit_execution_event(
        execution_id=str(execution_id),
        action="dlq_replay",
        user_id=None,
        details={"actor": actor, "error": entry.get("error")},
    )
    return {"ok": True, "execution_id": execution_id}


async def dlq_discard(index: int, *, actor: str = "cli") -> dict[str, Any]:
    client = await _redis()
    try:
        raw = await client.lindex(DLQ_KEY, index)
        if raw is None:
            return {"ok": False, "reason": "index out of range"}
        removed = await client.lrem(DLQ_KEY, 1, raw)
    finally:
        await client.aclose()
    try:
        entry = json.loads(raw)
    except json.JSONDecodeError:
        entry = {}
    await audit_execution_event(
        execution_id=str(entry.get("execution_id") or "dlq"),
        action="dlq_discard",
        user_id=None,
        details={"actor": actor, "entry": entry},
    )
    return {"ok": removed > 0}


def run_cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="dlq")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("stats")
    replay = sub.add_parser("replay")
    replay.add_argument("index", type=int)
    replay.add_argument("--actor", default="cli")
    discard = sub.add_parser("discard")
    discard.add_argument("index", type=int)
    discard.add_argument("--actor", default="cli")
    args = parser.parse_args()
    if args.command == "stats":
        print(json.dumps(asyncio.run(dlq_stats()), ensure_ascii=False, indent=2))
    elif args.command == "replay":
        print(json.dumps(asyncio.run(dlq_replay(args.index, actor=args.actor))))
    elif args.command == "discard":
        print(json.dumps(asyncio.run(dlq_discard(args.index, actor=args.actor))))


__all__ = ["DLQ_KEY", "dlq_discard", "dlq_replay", "dlq_stats", "run_cli"]
