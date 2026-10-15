"""Phase 8：只读 Production Baseline 报告（不制造负载，只聚合现有数据）。"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from sqlalchemy import func, select

from app.config import settings
from app.database import async_session_factory
from app.models import AuditLog, Execution, ToolCall
from app.models.enums import ExecutionStatus

logger = logging.getLogger(__name__)


def _pct(sorted_values: list[float], pct: float) -> float | None:
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * pct))]


async def build_baseline_report(
    start_time: datetime | None = None,
    end_time: datetime | None = None,
) -> dict[str, Any]:
    start_time = start_time or datetime.now(timezone.utc)
    end_time = end_time or datetime.now(timezone.utc)
    report: dict[str, Any] = {
        "window": {"start": start_time.isoformat(), "end": end_time.isoformat()},
        "requests": {"total": 0, "chat": 0, "knowledge": 0, "task": 0, "action": 0},
        "ttft_ms": {"p50": None, "p95": None},
        "ttl_ms": {"p50": None, "p95": None},
        "llm_latency_ms": {"p50": None, "p95": None},
        "tokens": {"input": 0, "output": 0},
        "cost": None,
        "cost_unknown_executions": 0,
        "fallback": {"calls": 0, "rate": 0.0},
        "retry": 0,
        "error": {"execution_failed": 0, "tool_failed": 0},
        "http_5xx": 0,
        "dlq_count": 0,
        "rag_latency_ms": {"p50": None, "p95": None},
        "approval_mismatch": 0,
        "side_effect_unknown": 0,
        "verification_traffic": False,
        "real_user_traffic": False,
    }
    async with async_session_factory() as session:
        executions = (
            (
                await session.execute(
                    select(Execution).where(
                        Execution.created_at >= start_time,
                        Execution.created_at <= end_time,
                    )
                )
            )
            .scalars()
            .all()
        )
        report["requests"]["total"] = len(executions)
        report["real_user_traffic"] = len(executions) > 0
        durations: list[float] = []
        input_tokens = output_tokens = 0
        cost_sum = 0.0
        cost_unknown = 0
        failed = 0
        for execution in executions:
            intent = execution.intent or {}
            category = str(intent.get("category") or "").lower()
            if category in report["requests"]:
                report["requests"][category] += 1
            if execution.completed_at is not None and execution.created_at is not None:
                durations.append(
                    (execution.completed_at - execution.created_at).total_seconds()
                    * 1000
                )
            input_tokens += int(execution.input_tokens or 0)
            output_tokens += int(execution.output_tokens or 0)
            if execution.cost is None:
                cost_unknown += 1
            else:
                cost_sum += float(execution.cost)
            if execution.status == ExecutionStatus.FAILED:
                failed += 1
        report["tokens"]["input"] = input_tokens
        report["tokens"]["output"] = output_tokens
        report["cost"] = (
            round(cost_sum, 8) if cost_sum else (None if cost_unknown else 0.0)
        )
        report["cost_unknown_executions"] = cost_unknown
        report["error"]["execution_failed"] = failed
        if durations:
            ordered = sorted(durations)
            report["ttl_ms"]["p50"] = round(_pct(ordered, 0.5) or 0, 1)
            report["ttl_ms"]["p95"] = round(_pct(ordered, 0.95) or 0, 1)

        tool_failed = (
            await session.execute(
                select(func.count(ToolCall.id)).where(
                    ToolCall.created_at >= start_time,
                    ToolCall.created_at <= end_time,
                    ToolCall.status == "failed",
                )
            )
        ).scalar()
        report["error"]["tool_failed"] = int(tool_failed or 0)

        spans = (
            (
                await session.execute(
                    select(AuditLog.details).where(
                        AuditLog.action.in_(["span:llm", "span:rag"]),
                        AuditLog.created_at >= start_time,
                        AuditLog.created_at <= end_time,
                    )
                )
            )
            .scalars()
            .all()
        )
        llm_latencies: list[float] = []
        rag_latencies: list[float] = []
        fallback_calls = 0
        for details in spans:
            details = details if isinstance(details, dict) else {}
            latency = details.get("latency_ms")
            if isinstance(latency, (int, float)):
                if details.get("span") == "rag":
                    rag_latencies.append(float(latency))
                else:
                    llm_latencies.append(float(latency))
            if details.get("fallback"):
                fallback_calls += 1
        if llm_latencies:
            ordered = sorted(llm_latencies)
            report["llm_latency_ms"]["p50"] = round(_pct(ordered, 0.5) or 0, 1)
            report["llm_latency_ms"]["p95"] = round(_pct(ordered, 0.95) or 0, 1)
        if rag_latencies:
            ordered = sorted(rag_latencies)
            report["rag_latency_ms"]["p50"] = round(_pct(ordered, 0.5) or 0, 1)
            report["rag_latency_ms"]["p95"] = round(_pct(ordered, 0.95) or 0, 1)
        report["fallback"]["calls"] = fallback_calls
        report["fallback"]["rate"] = (
            fallback_calls / len(llm_latencies) if llm_latencies else 0.0
        )
        mismatch = (
            await session.execute(
                select(func.count(AuditLog.id)).where(
                    AuditLog.action == "approval_mismatch",
                    AuditLog.created_at >= start_time,
                    AuditLog.created_at <= end_time,
                )
            )
        ).scalar()
        report["approval_mismatch"] = int(mismatch or 0)
        unknown = (
            await session.execute(
                select(func.count(AuditLog.id)).where(
                    AuditLog.action.in_(
                        ["side_effect_unknown", "side_effect_unknown_reconciled"]
                    ),
                    AuditLog.created_at >= start_time,
                    AuditLog.created_at <= end_time,
                )
            )
        ).scalar()
        report["side_effect_unknown"] = int(unknown or 0)

    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        report["dlq_count"] = await client.llen("dead_letter_queue")
    except Exception:  # noqa: BLE001
        report["dlq_count"] = -1
    finally:
        await client.aclose()
    return report


def render_baseline_report(report: dict[str, Any]) -> str:
    lines = [
        "POST_DEPLOY_BASELINE",
        f"window: {report['window']['start']} -> {report['window']['end']}",
        f"requests: {report['requests']}",
        f"TTFT: {report['ttft_ms']}",
        f"TTL: {report['ttl_ms']}",
        f"LLM latency: {report['llm_latency_ms']}",
        f"tokens: {report['tokens']}",
        f"cost: {report['cost']}",
        f"cost_unknown_executions: {report['cost_unknown_executions']}",
        f"fallback: {report['fallback']}",
        f"retry: {report['retry']}",
        f"error: {report['error']}",
        f"5xx: {report['http_5xx']}",
        f"dlq_count: {report['dlq_count']}",
        f"rag_latency: {report['rag_latency_ms']}",
        f"approval_mismatch: {report['approval_mismatch']}",
        f"side_effect_unknown: {report['side_effect_unknown']}",
        f"verification_traffic: {report['verification_traffic']}",
        f"real_user_traffic: {report['real_user_traffic']}",
        "note: 窗口内请求默认按真实用户流量计；验证流量需人工标注，本工具不冒充",
    ]
    return "\n".join(lines)


__all__ = ["build_baseline_report", "render_baseline_report"]
