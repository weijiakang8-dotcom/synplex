"""路由策略引擎（确定性、可审计）。

职责：把复杂度评分翻译成"这一步用便宜还是强的模型"，并给出理由。
- 三档用户策略（economy/balanced/quality）映射到不同的升级阈值；
- 历史绩效修正：便宜模型在该任务类型失败率 < 60% → 强制强模型（安全偏好）；
- 决策永远可解释，且由 routing_decisions 表留痕。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select

from app.core.complexity import ComplexityScore, explain
from app.database import async_session_factory
from app.models import ModelConfig, RoutingDecision

logger = logging.getLogger(__name__)

# 各档位"升级到强模型"的复杂度阈值：economy 最激进（省钱），quality 最保守
TIER_THRESHOLDS: dict[str, float] = {
    "economy": 0.65,
    "balanced": 0.5,
    "quality": 0.3,
}
DEFAULT_TIER = "balanced"
VALID_TIERS = frozenset(TIER_THRESHOLDS)

# 升级阶梯上限：每步最多升级 1 次（先便宜试，验证失败再升级，再失败交给人）
MAX_ESCALATIONS_PER_STEP = 1
MAX_ESCALATIONS_PER_TASK = 4


@dataclass(frozen=True)
class RouteChoice:
    """单步路由决策（执行前产生，执行后回填 outcome/model/cost 落库）。"""

    step_id: str
    capability: str
    score: float
    level: str
    tier: str
    complexity: str  # 传给 ModelGateway 的 simple/complex
    reason: str
    factors: list[dict[str, Any]] = field(default_factory=list)
    candidates: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_id": self.step_id,
            "capability": self.capability,
            "score": round(self.score, 4),
            "level": self.level,
            "tier": self.tier,
            "complexity": self.complexity,
            "reason": self.reason,
            "factors": self.factors,
            "candidates": self.candidates,
        }


def normalize_tier(tier: str | None) -> str:
    tier = (tier or "").strip().lower()
    return tier if tier in VALID_TIERS else DEFAULT_TIER


def choose_complexity(
    score: ComplexityScore,
    *,
    tier: str = DEFAULT_TIER,
    stats: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """返回 (complexity, reason)：simple 用便宜模型，complex 用强模型。

    历史修正优先于阈值（安全偏好）：便宜模型失败率高 → 强制 complex。
    """
    tier = normalize_tier(tier)
    threshold = TIER_THRESHOLDS[tier]
    reasons: list[str] = []
    complexity = "simple"

    if stats:
        attempts = int(stats.get("attempts") or 0)
        success_rate = stats.get("success_rate")
        if attempts >= 3 and success_rate is not None:
            try:
                rate = float(success_rate)
                if rate < 0.6:
                    complexity = "complex"
                    reasons.append(
                        f"历史修正：便宜模型成功率 {rate:.0%}（<60%），强制强模型"
                    )
                    return complexity, "；".join(reasons) + f"｜{explain(score)}"
                if rate > 0.9 and score.score < 0.7:
                    complexity = "simple"
                    reasons.append(
                        f"历史修正：便宜模型成功率 {rate:.0%}（>90%），放心用便宜"
                    )
                    return complexity, "；".join(reasons) + f"｜{explain(score)}"
            except (TypeError, ValueError):
                pass

    if score.score >= threshold:
        complexity = "complex"
        reasons.append(f"复杂度 {score.score:.2f} ≥ 档位阈值 {threshold}")
    else:
        complexity = "simple"
        reasons.append(f"复杂度 {score.score:.2f} < 档位阈值 {threshold}")
    return complexity, "；".join(reasons) + f"｜{explain(score)}"


async def model_candidates(organization_id: str | None = None) -> list[str]:
    """当前可用模型名（按成本升序），作为路由候选清单展示。"""
    try:
        async with async_session_factory() as session:
            stmt = select(ModelConfig).where(
                ModelConfig.is_active.is_(True),
                ModelConfig.enabled.is_(True),
            )
            if organization_id is not None:
                stmt = stmt.where(
                    (ModelConfig.organization_id.is_(None))
                    | (ModelConfig.organization_id == uuid.UUID(str(organization_id)))
                )
            result = await session.execute(
                stmt.order_by(ModelConfig.cost_per_1k_tokens)
            )
            return [str(row.model) for row in result.scalars().all()]
    except Exception:
        logger.warning("model_candidates failed", exc_info=True)
        return []


def build_route(
    step: dict[str, Any],
    step_score: ComplexityScore,
    *,
    tier: str = DEFAULT_TIER,
    stats: dict[str, Any] | None = None,
    candidates: list[str] | None = None,
) -> RouteChoice:
    """构造单步路由决策（纯函数，可测）。"""
    step_id = str(step.get("step_id") or step.get("capability") or "")
    capability = str(step.get("capability") or "answer")
    complexity, reason = choose_complexity(step_score, tier=tier, stats=stats)
    return RouteChoice(
        step_id=step_id,
        capability=capability,
        score=step_score.score,
        level=step_score.level,
        tier=normalize_tier(tier),
        complexity=complexity,
        reason=reason,
        factors=step_score.factors,
        candidates=list(candidates or []),
    )


def allow_escalation(
    escalated_steps: dict[str, int] | None,
    *,
    step_id: str,
    task_escalations: int = 0,
) -> bool:
    """升级阶梯闸门：每步 ≤1 次、每任务 ≤MAX_ESCALATIONS_PER_TASK 次。"""
    used = int((escalated_steps or {}).get(step_id, 0))
    return (
        used < MAX_ESCALATIONS_PER_STEP and task_escalations < MAX_ESCALATIONS_PER_TASK
    )


async def persist_route(
    choice: RouteChoice,
    *,
    execution_id: str | None = None,
    organization_id: str | None = None,
    outcome: str | None = None,
    model_used: str | None = None,
    cost: float | None = None,
) -> None:
    """路由决策落库（审计事实源；失败不阻塞主链路）。"""
    try:
        async with async_session_factory() as session:
            session.add(
                RoutingDecision(
                    execution_id=(
                        uuid.UUID(str(execution_id)) if execution_id else None
                    ),
                    step_id=choice.step_id,
                    step_capability=choice.capability,
                    score=choice.score,
                    tier=choice.tier,
                    chosen_complexity=choice.complexity,
                    reason=choice.reason,
                    factors=choice.factors,
                    candidates=choice.candidates,
                    outcome=outcome,
                    model_used=model_used,
                    cost=cost,
                    organization_id=(
                        uuid.UUID(str(organization_id)) if organization_id else None
                    ),
                )
            )
            await session.commit()
    except Exception:
        logger.warning("persist_route failed", exc_info=True)


__all__ = [
    "DEFAULT_TIER",
    "MAX_ESCALATIONS_PER_STEP",
    "MAX_ESCALATIONS_PER_TASK",
    "TIER_THRESHOLDS",
    "RouteChoice",
    "allow_escalation",
    "build_route",
    "choose_complexity",
    "model_candidates",
    "normalize_tier",
    "persist_route",
]
