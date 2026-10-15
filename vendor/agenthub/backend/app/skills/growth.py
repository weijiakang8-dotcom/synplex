"""Skill 自成长：从使用数据提炼用户习惯，提议打包成 Skill（绝不擅自生效）。

流程（闭环、可撤销、可审计）：
1. 聚类：executions 按"能力序列签名"聚合出反复出现的任务模式；
2. 提炼：出现 ≥MIN_OCCURRENCES 次且成功率达标 → 生成候选 Skill（source=auto,
   status=proposed），附证据（样本数/成功率）；
3. 用户确认：accept → status=active；拒绝 → status=retired；
4. 持续进化：skill 被使用后，按能力回读模型绩效档案，反哺 model_tier_hints
   （便宜模型成功率 ≥80% → simple；<60% → complex）。
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from app.core.profile import recent_task_types, stats_for
from app.database import async_session_factory
from app.models import Execution, Skill
from app.models.enums import ExecutionStatus

logger = logging.getLogger(__name__)

MIN_OCCURRENCES = 3
MIN_SUCCESS_RATE = 0.5


def signature_from_plan(plan: dict[str, Any] | None) -> tuple[str, ...]:
    """能力序列签名：忽略顺序外的细节，用于任务模式聚类。"""
    steps = (plan or {}).get("steps") or []
    return tuple(str(step.get("capability") or "") for step in steps)


def signature_label(signature: tuple[str, ...]) -> str:
    return " → ".join(signature) if signature else "answer"


async def propose_growth_skills(
    organization_id: str | None,
    *,
    days: int = 90,
) -> list[dict[str, Any]]:
    """扫描近 N 天执行记录，生成候选自成长 Skill（幂等：同一签名已有 auto skill 则跳过）。"""
    org_key = uuid.UUID(str(organization_id)) if organization_id else None
    since = datetime.now(timezone.utc) - timedelta(days=days)

    try:
        async with async_session_factory() as session:
            stmt = select(Execution).where(
                Execution.organization_id == org_key,
                Execution.created_at >= since,
                Execution.plan.isnot(None),
                Execution.status.in_(
                    [ExecutionStatus.COMPLETED, ExecutionStatus.FAILED]
                ),
            )
            result = await session.execute(stmt)
            executions = list(result.scalars().all())
            existing = list(
                (
                    await session.execute(
                        select(Skill).where(
                            Skill.organization_id == org_key,
                            Skill.source == "auto",
                        )
                    )
                )
                .scalars()
                .all()
            )
    except Exception:  # noqa: BLE001
        return []

    existing_signatures = {
        signature_from_plan(skill.plan_template) for skill in existing
    }

    clusters: dict[tuple[str, ...], dict[str, Any]] = {}
    for execution in executions:
        plan = execution.plan if isinstance(execution.plan, dict) else None
        signature = signature_from_plan(plan)
        if not signature:
            continue
        cluster = clusters.setdefault(
            signature,
            {
                "signature": signature,
                "count": 0,
                "successes": 0,
                "sample_input": execution.user_input or "",
                "plan": plan,
            },
        )
        cluster["count"] += 1
        delivery = (getattr(execution, "checkpoint_data", None) or {}).get("delivery")
        if execution.status == ExecutionStatus.COMPLETED and (
            delivery is None or delivery.get("status") == "completed"
        ):
            cluster["successes"] += 1

    proposals: list[dict[str, Any]] = []
    for cluster in clusters.values():
        signature = cluster["signature"]
        if signature in existing_signatures:
            continue
        if cluster["count"] < MIN_OCCURRENCES:
            continue
        success_rate = cluster["successes"] / cluster["count"]
        if success_rate < MIN_SUCCESS_RATE:
            continue
        label = signature_label(signature)
        skill = Skill(
            name=f"我的「{label}」流程",
            description=(
                f"自动发现：你近 {days} 天做过 {cluster['count']} 次类似任务"
                f"（成功率 {success_rate:.0%}）。示例：{cluster['sample_input'][:60]}"
            ),
            goal={"summary": label},
            plan_template=cluster["plan"],
            icon="wand-2",
            organization_id=org_key,
            created_by=None,
            source="auto",
            version=1,
            status="proposed",
            runtime="agent",
            trigger="",
            model_tier_hints=None,
        )
        try:
            async with async_session_factory() as session:
                session.add(skill)
                await session.commit()
                await session.refresh(skill)
        except Exception:
            logger.warning("persist proposed skill failed", exc_info=True)
            continue
        proposals.append(
            {
                "id": str(skill.id),
                "name": skill.name,
                "description": skill.description,
                "signature": label,
                "count": cluster["count"],
                "success_rate": round(success_rate, 4),
            }
        )
    return proposals


async def refine_skill_tier_hints(skill_id: uuid.UUID) -> dict[str, Any] | None:
    """按能力回读绩效档案，反哺 skill 的 model_tier_hints（持续进化闭环）。"""
    try:
        async with async_session_factory() as session:
            skill = await session.get(Skill, skill_id)
    except Exception:  # noqa: BLE001
        return None
    if skill is None:
        return None

    steps = (skill.plan_template or {}).get("steps") or []
    hints: dict[str, str] = {}
    org_id = str(skill.organization_id) if skill.organization_id else None
    for step in steps:
        capability = str(step.get("capability") or "")
        if not capability:
            continue
        stats = await stats_for(
            org_id,
            model=None,
            task_type=f"agent:{capability}",
            bucket="simple",
        )
        attempts = int(stats.get("attempts") or 0)
        success_rate = stats.get("success_rate")
        if attempts < 3 or success_rate is None:
            continue
        if success_rate >= 0.8:
            hints[capability] = "simple"
        elif success_rate < 0.6:
            hints[capability] = "complex"

    merged = dict(skill.model_tier_hints or {})
    merged.update(hints)
    if merged != skill.model_tier_hints:
        try:
            async with async_session_factory() as session:
                skill = await session.get(Skill, skill_id)
                if skill is not None:
                    skill.model_tier_hints = merged
                    skill.version += 1
                    await session.commit()
        except Exception:
            logger.warning("refine_skill_tier_hints persist failed", exc_info=True)
            return None
    return merged


async def recent_usage_signature(
    organization_id: str | None,
) -> list[dict[str, Any]]:
    """近况任务模式（供 /skills/growth 展示"平台看见的你"）。"""
    return await recent_task_types(organization_id)


__all__ = [
    "MIN_OCCURRENCES",
    "MIN_SUCCESS_RATE",
    "propose_growth_skills",
    "recent_usage_signature",
    "refine_skill_tier_hints",
    "signature_from_plan",
    "signature_label",
]
