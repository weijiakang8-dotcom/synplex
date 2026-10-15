"""省钱账单与 token 看板（不伪造数字）。

- baseline = 全部 token 按"最贵可用模型单价"计算（全 pro 假设）；
- actual = 实际按模型明细求和；unknown 价格不计入 savings（绝不编造）；
- 结果持久化到 savings_reports，可按周期查询；
- token 看板按模型聚合（输入/输出/成本/调用次数）。
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select

from app.database import async_session_factory
from app.models import ModelConfig, SavingsReport, UsageEvent

logger = logging.getLogger(__name__)


async def _max_rate(organization_id: str | None) -> float | None:
    """最贵可用模型单价（CNY / 1k tokens），作为全 pro 基线。"""
    try:
        async with async_session_factory() as session:
            stmt = select(ModelConfig).where(
                ModelConfig.is_active.is_(True),
                ModelConfig.enabled.is_(True),
            )
            if organization_id:
                stmt = stmt.where(
                    (ModelConfig.organization_id.is_(None))
                    | (ModelConfig.organization_id == uuid.UUID(str(organization_id)))
                )
            result = await session.execute(stmt)
            rows = list(result.scalars().all())
    except Exception:  # noqa: BLE001
        return None
    if not rows:
        return None
    return float(max(row.cost_per_1k_tokens for row in rows))


async def _rates_by_model(organization_id: str | None) -> dict[str, float]:
    try:
        async with async_session_factory() as session:
            stmt = select(ModelConfig).where(
                ModelConfig.is_active.is_(True),
                ModelConfig.enabled.is_(True),
            )
            if organization_id:
                stmt = stmt.where(
                    (ModelConfig.organization_id.is_(None))
                    | (ModelConfig.organization_id == uuid.UUID(str(organization_id)))
                )
            result = await session.execute(stmt)
            rows = list(result.scalars().all())
    except Exception:  # noqa: BLE001
        return {}
    rates: dict[str, float] = {}
    for row in rows:
        rates[str(row.model)] = float(row.cost_per_1k_tokens)
    return rates


async def compute_savings(
    organization_id: str | None,
    *,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> dict[str, Any]:
    """计算一个周期的省钱账单并落库。返回汇总 dict。"""
    end = period_end or datetime.now(timezone.utc)
    start = period_start or (end - timedelta(days=30))
    org_key = uuid.UUID(str(organization_id)) if organization_id else None

    try:
        async with async_session_factory() as session:
            stmt = select(UsageEvent).where(
                UsageEvent.created_at >= start,
                UsageEvent.created_at < end,
                UsageEvent.organization_id == org_key,
            )
            result = await session.execute(stmt)
            events = list(result.scalars().all())
    except Exception:  # noqa: BLE001
        return {
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "baseline_cost": 0.0,
            "actual_cost": 0.0,
            "savings": 0.0,
            "savings_rate": 0.0,
            "total_tokens": 0,
            "by_model": [],
            "note": "usage data unavailable",
        }

    max_rate = await _max_rate(organization_id)

    total_tokens = 0
    actual_cost = 0.0
    priced_tokens = 0
    unknown_price_calls = 0
    estimated_usage_calls = 0
    by_model: dict[str, dict[str, Any]] = {}
    for event in events:
        estimated_usage_calls += int(event.status in {"estimated", "partial_estimate"})
        tokens = int(event.input_tokens) + int(event.output_tokens)
        total_tokens += tokens
        cost = event.cost
        if cost is not None:
            actual_cost += float(cost)
            priced_tokens += tokens
        else:
            unknown_price_calls += 1
        model = str(event.model or "unknown")
        bucket = by_model.setdefault(
            model,
            {
                "model": model,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost": 0.0,
                "calls": 0,
                "unknown_price_calls": 0,
            },
        )
        bucket["input_tokens"] += int(event.input_tokens)
        bucket["output_tokens"] += int(event.output_tokens)
        bucket["cost"] += float(cost or 0.0)
        bucket["calls"] += 1
        bucket["unknown_price_calls"] += int(cost is None)

    baseline_cost = 0.0
    if max_rate:
        # Only compare the same priced-token subset.
        baseline_cost = round(priced_tokens / 1000.0 * max_rate, 8)

    savings = round(max(0.0, baseline_cost - actual_cost), 8)
    savings_rate = round(savings / baseline_cost, 4) if baseline_cost > 0 else 0.0

    summary = {
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "baseline_cost": baseline_cost,
        "actual_cost": round(actual_cost, 8),
        "savings": savings,
        "savings_rate": savings_rate,
        "total_tokens": total_tokens,
        "max_rate": max_rate,
        "priced_tokens": priced_tokens,
        "unknown_price_calls": unknown_price_calls,
        "estimated_usage_calls": estimated_usage_calls,
        "cost_complete": unknown_price_calls == 0,
        "note": "全强模型基线为估算，仅比较已知价格调用；未知价格不计为零。",
        "by_model": sorted(
            by_model.values(), key=lambda item: item["cost"], reverse=True
        ),
    }

    try:
        async with async_session_factory() as session:
            session.add(
                SavingsReport(
                    organization_id=org_key,
                    period_start=start,
                    period_end=end,
                    baseline_cost=baseline_cost,
                    actual_cost=round(actual_cost, 8),
                    savings=savings,
                    savings_rate=savings_rate,
                    total_tokens=total_tokens,
                    details=summary,
                )
            )
            await session.commit()
    except Exception:
        logger.warning("persist savings report failed", exc_info=True)

    return summary


async def latest_savings(organization_id: str | None) -> dict[str, Any] | None:
    try:
        async with async_session_factory() as session:
            stmt = (
                select(SavingsReport)
                .where(
                    SavingsReport.organization_id
                    == (uuid.UUID(str(organization_id)) if organization_id else None)
                )
                .order_by(SavingsReport.created_at.desc())
                .limit(1)
            )
            result = await session.execute(stmt)
            row = result.scalars().first()
    except Exception:  # noqa: BLE001
        return None
    if row is None:
        return None
    return row.details


async def token_dashboard(
    organization_id: str | None,
    *,
    days: int = 30,
) -> dict[str, Any]:
    """token 看板：按模型聚合近 N 天的消耗。"""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    org_key = uuid.UUID(str(organization_id)) if organization_id else None
    try:
        async with async_session_factory() as session:
            stmt = (
                select(
                    UsageEvent.model,
                    func.sum(UsageEvent.input_tokens).label("input_tokens"),
                    func.sum(UsageEvent.output_tokens).label("output_tokens"),
                    func.sum(UsageEvent.cost).label("cost"),
                    func.count().label("calls"),
                )
                .where(
                    UsageEvent.created_at >= start,
                    UsageEvent.organization_id == org_key,
                    UsageEvent.model.isnot(None),
                )
                .group_by(UsageEvent.model)
                .order_by(func.sum(UsageEvent.cost).desc())
            )
            result = await session.execute(stmt)
            rows = [
                {
                    "model": row.model,
                    "input_tokens": int(row.input_tokens or 0),
                    "output_tokens": int(row.output_tokens or 0),
                    "cost": round(float(row.cost or 0.0), 8),
                    "calls": int(row.calls or 0),
                }
                for row in result.all()
            ]
    except Exception:  # noqa: BLE001
        return {
            "days": days,
            "models": [],
            "total": {"tokens": 0, "cost": 0.0, "calls": 0},
        }

    return {
        "days": days,
        "models": rows,
        "total": {
            "tokens": sum(r["input_tokens"] + r["output_tokens"] for r in rows),
            "cost": round(sum(r["cost"] for r in rows), 8),
            "calls": sum(r["calls"] for r in rows),
        },
    }


__all__ = [
    "compute_savings",
    "latest_savings",
    "token_dashboard",
]
