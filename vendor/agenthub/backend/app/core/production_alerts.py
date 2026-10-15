"""Phase 6B：最小生产告警（阈值可配置、复用 alert_events/notify、低噪声）。"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import func, select

from app.config import settings
from app.core.alerting import _notify
from app.database import async_session_factory
from app.models import AlertEvent, AuditLog, Execution, ToolCall
from app.models.enums import ExecutionStatus, ToolCallStatus

logger = logging.getLogger(__name__)


async def collect_production_metrics() -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        metrics["dlq_count"] = await client.llen("dead_letter_queue")
    except Exception:  # noqa: BLE001
        metrics["dlq_count"] = -1
    finally:
        await client.aclose()

    async with async_session_factory() as session:
        metrics["pending_executions"] = int(
            (
                await session.execute(
                    select(func.count(Execution.id)).where(
                        Execution.status == ExecutionStatus.PENDING
                    )
                )
            ).scalar()
            or 0
        )
        metrics["in_flight_tool_calls"] = int(
            (
                await session.execute(
                    select(func.count(ToolCall.id)).where(
                        ToolCall.status == ToolCallStatus.IN_FLIGHT
                    )
                )
            ).scalar()
            or 0
        )
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        mismatch = await session.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.action == "approval_mismatch",
                AuditLog.created_at >= since,
            )
        )
        metrics["approval_mismatch_24h"] = int(mismatch.scalar() or 0)
        unknown = await session.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.action.in_(
                    ["side_effect_unknown", "side_effect_unknown_reconciled"]
                ),
                AuditLog.created_at >= since,
            )
        )
        metrics["side_effect_unknown_24h"] = int(unknown.scalar() or 0)

        spans = (
            (
                await session.execute(
                    select(AuditLog.details).where(
                        AuditLog.action == "span:llm",
                        AuditLog.created_at >= since,
                    )
                )
            )
            .scalars()
            .all()
        )
    fallback_count = 0
    latencies: list[float] = []
    for details in spans:
        details = details if isinstance(details, dict) else {}
        if details.get("fallback"):
            fallback_count += 1
        latency = details.get("latency_ms")
        if isinstance(latency, (int, float)):
            latencies.append(float(latency))
    metrics["llm_calls_24h"] = len(spans)
    metrics["llm_fallback_24h"] = fallback_count
    metrics["llm_fallback_rate"] = fallback_count / len(spans) if spans else 0.0
    metrics["llm_latency_p95_ms"] = (
        sorted(latencies)[min(len(latencies) - 1, int(len(latencies) * 0.95))]
        if latencies
        else None
    )
    try:
        async with async_session_factory() as session:
            await session.execute(select(1))
        metrics["database_ok"] = True
    except Exception:  # noqa: BLE001
        metrics["database_ok"] = False
    try:
        client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            metrics["redis_ok"] = bool(await client.ping())
        finally:
            await client.aclose()
    except Exception:  # noqa: BLE001
        metrics["redis_ok"] = False
    return metrics


def evaluate_production_alerts(
    metrics: dict[str, Any],
) -> list[dict[str, Any]]:
    checks: list[tuple[str, str, Any, Any, bool]] = [
        (
            "dlq_growth",
            "warning",
            metrics.get("dlq_count", 0),
            settings.ALERT_DLQ_MIN,
            int(metrics.get("dlq_count", 0) or 0) >= settings.ALERT_DLQ_MIN,
        ),
        (
            "pending_executions_stuck",
            "warning",
            metrics.get("pending_executions", 0),
            settings.ALERT_PENDING_MIN,
            int(metrics.get("pending_executions", 0) or 0)
            >= settings.ALERT_PENDING_MIN,
        ),
        (
            "side_effect_unknown",
            "critical",
            metrics.get("in_flight_tool_calls", 0),
            1,
            int(metrics.get("in_flight_tool_calls", 0) or 0) >= 1,
        ),
        (
            "approval_mismatch",
            "critical",
            metrics.get("approval_mismatch_24h", 0),
            1,
            int(metrics.get("approval_mismatch_24h", 0) or 0) >= 1,
        ),
        (
            "llm_fallback_rate",
            "warning",
            metrics.get("llm_fallback_rate", 0.0),
            settings.ALERT_FALLBACK_RATE,
            float(metrics.get("llm_fallback_rate", 0.0) or 0.0)
            >= settings.ALERT_FALLBACK_RATE,
        ),
        (
            "llm_latency_p95",
            "warning",
            metrics.get("llm_latency_p95_ms"),
            settings.ALERT_LATENCY_P95_MS,
            (
                metrics.get("llm_latency_p95_ms") is not None
                and float(metrics["llm_latency_p95_ms"])
                >= settings.ALERT_LATENCY_P95_MS
            ),
        ),
        (
            "database_unhealthy",
            "critical",
            metrics.get("database_ok"),
            True,
            metrics.get("database_ok") is False,
        ),
        (
            "redis_unhealthy",
            "critical",
            metrics.get("redis_ok"),
            True,
            metrics.get("redis_ok") is False,
        ),
    ]
    alerts = []
    for name, severity, value, threshold, breached in checks:
        alerts.append(
            {
                "name": name,
                "severity": severity,
                "value": value,
                "threshold": threshold,
                "ok": not breached,
            }
        )
    return alerts


async def run_production_alerts() -> list[AlertEvent]:
    """评估并写入 AlertEvent（cooldown 抑制噪声），复用 _notify。"""
    metrics = await collect_production_metrics()
    alerts = evaluate_production_alerts(metrics)
    created: list[AlertEvent] = []
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=settings.ALERT_COOLDOWN_MINUTES
    )
    async with async_session_factory() as session:
        for alert in alerts:
            if alert["ok"]:
                continue
            existing = (
                await session.execute(
                    select(AlertEvent).where(
                        AlertEvent.rule_id == alert["name"],
                        AlertEvent.status == "active",
                        AlertEvent.triggered_at > cutoff,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                continue
            event = AlertEvent(
                rule_id=alert["name"],
                severity=alert["severity"],
                message=(
                    f"{alert['name']}: value={alert['value']} "
                    f"threshold={alert['threshold']}"
                ),
            )
            session.add(event)
            created.append(event)
        await session.commit()
    for event in created:
        await _notify(event.rule_id, event.severity, event.message)
    return created


__all__ = [
    "collect_production_metrics",
    "evaluate_production_alerts",
    "run_production_alerts",
]
