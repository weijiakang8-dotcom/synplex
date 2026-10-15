"""复杂度评分器（调度中心发动机）。

三层混合，先便宜后昂贵、永远可解释：
1. 规则信号（零成本）：意图 flags / 计划结构 / 能力类型 / 输入规模；
2. 历史统计（越用越准）：模型绩效档案对评分的修正；
3. 可选 LLM 法官（灰区才启用，最便宜模型执行，成本单独入账）。

评分产物 ComplexityScore 可直接序列化进事件流与 routing_decisions 审计。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# 能力 → 相对推理强度（0..1）。检索/记忆便宜做，综合分析贵做。
CAPABILITY_WEIGHTS: dict[str, float] = {
    "answer": 0.25,
    "web_search": 0.15,
    "research": 0.3,
    "search_knowledge": 0.2,
    "knowledge": 0.2,
    "recall": 0.15,
    "query_db": 0.35,
    "analysis": 0.5,
    "send_email": 0.4,
    "execute": 0.45,
}

DEFAULT_WEIGHT = 0.3
GRAY_ZONE = (0.3, 0.7)


def capability_weight(capability: str) -> float:
    name = str(capability or "").strip()
    return CAPABILITY_WEIGHTS.get(name, DEFAULT_WEIGHT)


@dataclass(frozen=True)
class ComplexityScore:
    """0..1 复杂度评分 + 可解释因子。"""

    score: float
    level: str  # simple | complex
    source: str  # rules | rules+judge | rules+stats
    confidence: float
    factors: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 4),
            "level": self.level,
            "source": self.source,
            "confidence": round(self.confidence, 4),
            "factors": self.factors,
        }


def _factor(name: str, weight: float, detail: str) -> dict[str, Any]:
    return {
        "factor": name,
        "weight": round(weight, 4),
        "contribution": round(weight, 4),
        "detail": detail,
    }


def _clamp(value: float, low: float = 0.05, high: float = 0.95) -> float:
    return max(low, min(high, value))


def score_task(
    user_input: str,
    intent: dict[str, Any] | None = None,
    plan: dict[str, Any] | None = None,
    *,
    judge_result: dict[str, Any] | None = None,
    stats: dict[str, Any] | None = None,
) -> ComplexityScore:
    """任务级复杂度评分（纯规则 + 可选法官/统计修正，同步确定性）。

    judge_result 由调用方经 LLM 法官产生（{score, confidence, reason}）；
    stats 来自模型绩效档案（{success_rate, attempts}），供路由层做修正。
    """
    intent = intent or {}
    factors: list[dict[str, Any]] = []
    score = 0.1

    def add(factor: str, weight: float, condition: bool, detail: str) -> None:
        nonlocal score
        if condition:
            score += weight
            factors.append(_factor(factor, weight, detail))

    category = str(intent.get("category") or "")
    add("category_task", 0.05, category == "TASK", "意图为任务型")
    add("category_action", 0.15, category == "ACTION", "意图含副作用")
    add("requires_tool", 0.15, bool(intent.get("requires_tool")), "需要工具调用")
    add("requires_data", 0.15, bool(intent.get("requires_data")), "需要数据查询")
    add(
        "requires_side_effect",
        0.2,
        bool(intent.get("requires_side_effect")),
        "含真实副作用",
    )
    add("multi_goal", 0.15, bool(intent.get("multi_goal")), "多目标并行")
    add("needs_web_search", 0.1, bool(intent.get("needs_web_search")), "需要联网检索")
    add("long_input", 0.05, len(str(user_input or "")) > 500, "输入较长")

    steps = (plan or {}).get("steps") or []
    if steps:
        count = len(steps)
        if count >= 4:
            add("many_steps", 0.2, True, f"{count} 个步骤")
        elif count == 3:
            add("many_steps", 0.12, True, f"{count} 个步骤")
        elif count == 2:
            add("many_steps", 0.05, True, f"{count} 个步骤")
        add(
            "side_effect_step",
            0.2,
            any(bool(step.get("side_effect")) for step in steps),
            "计划含副作用步骤",
        )
        heavy = any(
            capability_weight(str(step.get("capability") or "")) >= 0.45
            for step in steps
        )
        add("heavy_reasoning", 0.1, heavy, "含综合分析/执行步骤")
        add(
            "dependencies",
            0.05,
            any(step.get("depends_on") for step in steps),
            "步骤间有依赖",
        )

    score = _clamp(score)
    level = "complex" if score >= 0.5 else "simple"
    source = "rules"
    confidence = 0.8

    # LLM 法官修正：仅在灰区启用（由调用方决定是否传入）
    if isinstance(judge_result, dict):
        try:
            judge_score = _clamp(float(judge_result.get("score", score)))
            judge_confidence = _clamp(
                float(judge_result.get("confidence", 0.5)), 0.1, 1.0
            )
            before = score
            score = _clamp(score * 0.6 + judge_score * 0.4)
            factors.append(
                _factor(
                    "llm_judge",
                    round(score - before, 4),
                    str(judge_result.get("reason", ""))[:200],
                )
            )
            source = "rules+judge"
            confidence = round(0.6 + 0.4 * judge_confidence, 4)
        except (TypeError, ValueError):
            pass

    # 历史统计修正：便宜模型在该任务类型下失败率高 → 上调评分（安全偏好）
    if isinstance(stats, dict):
        attempts = int(stats.get("attempts") or 0)
        success_rate = stats.get("success_rate")
        if attempts >= 3 and success_rate is not None:
            try:
                rate = float(success_rate)
                if rate < 0.6:
                    score = _clamp(score + 0.15)
                    factors.append(
                        _factor("history_weak", 0.15, f"便宜模型历史成功率 {rate:.0%}")
                    )
                elif rate > 0.9:
                    score = _clamp(score - 0.1)
                    factors.append(
                        _factor(
                            "history_strong", -0.1, f"便宜模型历史成功率 {rate:.0%}"
                        )
                    )
                source = "rules+stats"
            except (TypeError, ValueError):
                pass

    level = "complex" if score >= 0.5 else "simple"
    return ComplexityScore(
        score=_clamp(score),
        level=level,
        source=source,
        confidence=confidence,
        factors=factors,
    )


def score_step(
    step: dict[str, Any],
    task_score: float,
    *,
    task_level: str = "simple",
) -> ComplexityScore:
    """步骤级复杂度：任务分与能力权重的混合，纯确定性。"""
    capability = str(step.get("capability") or "answer")
    weight = capability_weight(capability)
    base = _clamp(task_score * 0.5 + weight * 0.5)
    factors = [
        _factor("task_score", task_score * 0.5, f"任务复杂度 {task_score:.2f}"),
        _factor("capability", weight * 0.5, f"能力 {capability} 权重 {weight:.2f}"),
    ]
    level = "complex" if base >= 0.5 else "simple"
    return ComplexityScore(
        score=base,
        level=level,
        source="rules",
        confidence=0.9,
        factors=factors,
    )


def explain(score: ComplexityScore) -> str:
    """人类可读的解释（路由审计 reason 字段）。"""
    parts = [f"复杂度 {score.score:.2f}（{score.level}）"]
    for factor in score.factors:
        parts.append(f"{factor['detail']}")
    return "；".join(parts)


def in_gray_zone(score: float) -> bool:
    return GRAY_ZONE[0] <= score <= GRAY_ZONE[1]


__all__ = [
    "CAPABILITY_WEIGHTS",
    "ComplexityScore",
    "capability_weight",
    "explain",
    "in_gray_zone",
    "score_step",
    "score_task",
]
