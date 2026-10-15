"""最小 Observability（Phase 2 Contract 06）。

一轮用户请求 = 一个 trace_id（execution.correlation_id）。
固定 span 集合：intent / memory / rag / plan / step / llm / tool / verify / respond。
每个 span 至少记录 start/end/latency/tokens/cost/status/model/attempt/error。

实现优先复用现有 audit_logs（action 前缀 span:）与 correlation_id，不引入新服务。
测试环境通过 AGENTHUB_OBSERVABILITY_DISABLED=true 关闭持久化（与 OTEL 一致）。
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from app.database import async_session_factory
from app.models import AuditLog

logger = logging.getLogger(__name__)

SPAN_NAMES = frozenset(
    {"intent", "memory", "rag", "plan", "step", "llm", "tool", "verify", "respond"}
)

_DISABLED = os.environ.get("AGENTHUB_OBSERVABILITY_DISABLED", "").lower() in {
    "1",
    "true",
    "yes",
}


async def record_span(
    *,
    trace_id: str | None,
    name: str,
    start: float | None = None,
    end: float | None = None,
    status: str = "ok",
    tokens: int | None = None,
    cost: float | None = None,
    model: str | None = None,
    attempt: int | None = None,
    error: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """持久化一个 span 到 audit_logs（best-effort，失败不打断业务）。"""
    if _DISABLED or not trace_id:
        return
    if name not in SPAN_NAMES:
        logger.warning("Unknown observability span name: %s", name)
        return
    start_ts = start if start is not None else time.perf_counter()
    end_ts = end if end is not None else time.perf_counter()
    try:
        async with async_session_factory() as session:
            session.add(
                AuditLog(
                    organization_id=details.get("organization_id") if details else None,
                    user_id=details.get("user_id") if details else None,
                    method="TRACE",
                    path=f"/trace/{trace_id}/{name}",
                    status_code=0,
                    action=f"span:{name}",
                    resource_type="trace",
                    resource_id=str(trace_id),
                    details={
                        "trace_id": str(trace_id),
                        "span": name,
                        "start": start_ts,
                        "end": end_ts,
                        "latency_ms": round(max(0.0, end_ts - start_ts) * 1000, 3),
                        "tokens": tokens,
                        "cost": cost,
                        "status": status,
                        "model": model,
                        "attempt": attempt,
                        "error": error,
                        "recorded_at": datetime.now(timezone.utc).isoformat(),
                        **(details or {}),
                    },
                )
            )
            await session.commit()
    except Exception:
        logger.debug("Failed to persist observability span %s", name, exc_info=True)


@asynccontextmanager
async def trace_span(
    trace_id: str | None,
    name: str,
    **fields: Any,
) -> AsyncIterator[None]:
    """异步上下文：自动记录 start/end/latency/status/error。"""
    start = time.perf_counter()
    try:
        yield
    except Exception as exc:
        await record_span(
            trace_id=trace_id,
            name=name,
            start=start,
            end=time.perf_counter(),
            status="error",
            error=str(exc)[:500],
            details=dict(fields),
        )
        raise
    status = fields.pop("status", "ok")
    await record_span(
        trace_id=trace_id,
        name=name,
        start=start,
        end=time.perf_counter(),
        status=status,
        details=dict(fields),
    )


__all__ = ["SPAN_NAMES", "record_span", "trace_span"]
