"""行为画像与模型绩效（自成长的土壤）。

- record_usage：把图节点收集的 usage 明细写入 usage_events（token 看板数据源）；
- update_model_performance：成功/失败/成本回写 model_performance（越用越准）；
- stats_for：给路由层读"便宜模型在该任务类型下靠不靠谱"；
- 时间衰减：超过 DECAY_DAYS 的统计在读取时按指数折减权重，防任务漂移带偏路由。
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.database import async_session_factory
from app.models import ModelPerformance, UsageEvent

logger = logging.getLogger(__name__)

DECAY_HALF_LIFE_DAYS = 60.0  # 绩效统计半衰期：60 天前的样本权重减半


async def record_usage_events(
    usage: list[dict[str, Any]],
    *,
    execution_id: str | None = None,
    organization_id: str | None = None,
    user_id: str | None = None,
    task_type: str = "task",
    step_capability: str = "",
    complexity: str = "simple",
) -> int:
    """usage 明细落库；usage 条目来自 ModelGateway 的 _agenthub_llm 元数据。"""
    if not usage:
        return 0

    def _parse_uuid(value: str | None) -> uuid.UUID | None:
        if not value:
            return None
        try:
            return uuid.UUID(str(value))
        except (ValueError, TypeError):
            return None

    try:
        rows = [
            UsageEvent(
                id=_parse_uuid(item.get("call_id")) or uuid.uuid4(),
                execution_id=_parse_uuid(execution_id),
                organization_id=_parse_uuid(organization_id),
                user_id=_parse_uuid(user_id),
                task_type=task_type,
                step_capability=step_capability,
                complexity=complexity,
                model=str(item.get("model_used") or "") or None,
                input_tokens=int(item.get("input_tokens") or 0),
                output_tokens=int(item.get("output_tokens") or 0),
                cost=(float(item["cost"]) if item.get("cost") is not None else None),
                latency_ms=0.0,
                status=(
                    (
                        "partial_estimate"
                        if item.get("usage_source") == "estimate"
                        else "partial"
                    )
                    if item.get("interrupted")
                    else (
                        "estimated"
                        if item.get("usage_source") == "estimate"
                        else "success"
                    )
                ),
            )
            for item in usage
        ]
        async with async_session_factory() as session:
            inserted = 0
            for row in rows:
                values = {
                    column.name: getattr(row, column.name)
                    for column in UsageEvent.__table__.columns
                    if column.name not in {"created_at", "updated_at"}
                }
                result = await session.execute(
                    pg_insert(UsageEvent)
                    .values(**values)
                    .on_conflict_do_nothing(index_elements=[UsageEvent.id])
                    .returning(UsageEvent.id)
                )
                inserted += int(result.scalar_one_or_none() is not None)
            await session.commit()
        return inserted
    except Exception:
        logger.warning("record_usage_events failed", exc_info=True)
        return 0


async def update_model_performance(
    *,
    organization_id: str | None,
    model: str | None,
    task_type: str,
    bucket: str,
    success: bool,
    cost: float = 0.0,
    latency_ms: float = 0.0,
) -> None:
    """upsert 一条绩效样本（attempts/successes/cost/latency 增量）。"""
    if not model:
        return
    key_org = uuid.UUID(str(organization_id)) if organization_id else None
    try:
        async with async_session_factory() as session:
            stmt = pg_insert(ModelPerformance).values(
                organization_id=key_org,
                model=str(model),
                task_type=task_type,
                bucket=bucket,
                attempts=1,
                successes=1 if success else 0,
                total_cost=cost,
                avg_latency_ms=latency_ms,
            )
            stmt = stmt.on_conflict_do_update(
                constraint="uq_model_performance_org_model_task_bucket",
                set_={
                    "attempts": ModelPerformance.attempts + 1,
                    "successes": ModelPerformance.successes + (1 if success else 0),
                    "total_cost": ModelPerformance.total_cost + cost,
                    "avg_latency_ms": (
                        ModelPerformance.avg_latency_ms * ModelPerformance.attempts
                        + latency_ms
                    )
                    / (ModelPerformance.attempts + 1),
                },
            )
            await session.execute(stmt)
            await session.commit()
    except Exception:
        logger.warning("update_model_performance failed", exc_info=True)


def _decay_weight(updated_at: datetime, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    age_days = max(0.0, (now - updated_at).total_seconds() / 86400.0)
    return math.exp(-age_days / DECAY_HALF_LIFE_DAYS * math.log(2))


async def stats_for(
    organization_id: str | None,
    *,
    model: str | None,
    task_type: str,
    bucket: str = "simple",
) -> dict[str, Any]:
    """便宜模型在该任务类型下的成功率（含时间衰减聚合）。"""
    try:
        async with async_session_factory() as session:
            stmt = select(ModelPerformance).where(
                ModelPerformance.task_type == task_type,
                ModelPerformance.bucket == bucket,
            )
            if model:
                stmt = stmt.where(ModelPerformance.model == model)
            if organization_id:
                stmt = stmt.where(
                    (ModelPerformance.organization_id.is_(None))
                    | (
                        ModelPerformance.organization_id
                        == uuid.UUID(str(organization_id))
                    )
                )
            result = await session.execute(stmt)
            rows = list(result.scalars().all())
    except Exception:  # noqa: BLE001
        return {}

    weighted_attempts = 0.0
    weighted_successes = 0.0
    for row in rows:
        weight = _decay_weight(row.updated_at)
        weighted_attempts += row.attempts * weight
        weighted_successes += row.successes * weight
    if weighted_attempts < 0.5:
        return {"attempts": 0, "success_rate": None}
    return {
        "attempts": round(weighted_attempts),
        "success_rate": round(weighted_successes / weighted_attempts, 4),
    }


async def record_delivery_performance(execution_id: str, delivery: dict) -> None:
    """Only certified deliveries (or explicit verification failure) train quality routing."""
    status, verification = delivery.get("status"), delivery.get("verification")
    if (
        not (status == "completed" and verification == "PASS")
        and verification != "FAIL"
    ):
        return
    async with async_session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(UsageEvent).where(
                        UsageEvent.execution_id == uuid.UUID(str(execution_id))
                    )
                )
            )
            .scalars()
            .all()
        )
    groups = {}
    for row in rows:
        if not row.model or not row.task_type.startswith("agent:"):
            continue
        key = (
            str(row.organization_id) if row.organization_id else None,
            row.model,
            row.task_type,
            row.complexity,
        )
        groups[key] = groups.get(key, 0.0) + float(row.cost or 0)
    for (org, model, task, bucket), cost in groups.items():
        await update_model_performance(
            organization_id=org,
            model=model,
            task_type=f"delivered:{task}",
            bucket=bucket,
            success=status == "completed" and verification == "PASS",
            cost=cost,
        )


async def recent_task_types(
    organization_id: str | None,
    *,
    limit: int = 6,
) -> list[dict[str, Any]]:
    """最近的任务类型分布（自成长 Skill 聚类的原料）。"""
    try:
        async with async_session_factory() as session:
            stmt = (
                select(
                    UsageEvent.task_type,
                    UsageEvent.step_capability,
                    func.count().label("calls"),
                )
                .group_by(UsageEvent.task_type, UsageEvent.step_capability)
                .order_by(func.count().desc())
                .limit(limit)
            )
            if organization_id:
                stmt = stmt.where(
                    UsageEvent.organization_id == uuid.UUID(str(organization_id))
                )
            result = await session.execute(stmt)
            return [
                {
                    "task_type": row.task_type,
                    "capability": row.step_capability,
                    "calls": int(row.calls),
                }
                for row in result.all()
            ]
    except Exception:  # noqa: BLE001
        return []


__all__ = [
    "DECAY_HALF_LIFE_DAYS",
    "recent_task_types",
    "record_usage_events",
    "stats_for",
    "update_model_performance",
]
