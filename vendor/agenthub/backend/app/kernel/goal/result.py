from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class GoalStatus(StrEnum):
    SATISFIED = "SATISFIED"
    NOT_SATISFIED = "NOT_SATISFIED"


class GoalEvaluationResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: GoalStatus
    goal_id: str
    predicate_result: bool
    evidence_result: str
    constraint_result: bool
    reasons: dict[str, str] = Field(default_factory=dict)


__all__ = ["GoalEvaluationResult", "GoalStatus"]
