from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.evidence.model import EvidenceLevel


class GoalPredicate(BaseModel):
    """确定性、无副作用的 Goal 谓词（白名单求值）。"""

    model_config = ConfigDict(frozen=True)

    name: str
    params: dict[str, Any] = Field(default_factory=dict)


class Constraint(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    params: dict[str, Any] = Field(default_factory=dict)
    hard: bool = True


class Goal(BaseModel):
    """State 的约束，不是 Agent 的任务描述。"""

    model_config = ConfigDict(frozen=True)

    goal_id: str
    predicate: GoalPredicate
    required_evidence: EvidenceLevel
    constraints: list[Constraint] = Field(default_factory=list)


__all__ = ["Constraint", "Goal", "GoalPredicate"]
