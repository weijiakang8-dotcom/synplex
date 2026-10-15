"""Phase 6B：Prometheus 生产指标（复用现有 /metrics，不引入新系统）。"""

from __future__ import annotations

from typing import Any

from prometheus_client import Gauge


def _build_gauges() -> dict[str, Gauge]:
    names = [
        "dlq_count",
        "pending_executions",
        "in_flight_tool_calls",
        "approval_mismatch_24h",
        "side_effect_unknown_24h",
        "llm_calls_24h",
        "llm_fallback_24h",
        "llm_fallback_rate",
        "llm_latency_p95_ms",
        "database_ok",
        "redis_ok",
    ]
    return {
        name: Gauge(f"agenthub_{name}", f"AgentHub production metric: {name}")
        for name in names
    }


_GAUGES = _build_gauges()


def update_production_gauges(metrics: dict[str, Any]) -> None:
    for name, gauge in _GAUGES.items():
        value = metrics.get(name)
        if value is None:
            continue
        try:
            gauge.set(float(value))
        except (TypeError, ValueError):
            gauge.set(0.0)


__all__ = ["update_production_gauges"]
