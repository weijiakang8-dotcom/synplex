from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.goal.result import GoalEvaluationResult
from app.kernel.runtime.model import TerminationReason
from app.kernel.state.model import State


class RuntimeTraceEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    step_index: int
    task_id: str
    capability_id: str
    action: str
    result: str
    reason: str | None = None
    evidence_before: str | None = None
    evidence_after: str | None = None
    observation_id: str | None = None
    produced_artifacts: list[str] | None = None


class EffectHistoryEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    command_id: str
    idempotency_key: str
    receipt_status: str
    reconciliation: str | None = None


class RuntimeOutput(BaseModel):
    model_config = ConfigDict(frozen=True)

    final_state: State
    goal_result: GoalEvaluationResult
    execution_trace: list[RuntimeTraceEntry] = Field(default_factory=list)
    effect_history: list[EffectHistoryEntry] = Field(default_factory=list)
    applied_tasks: list[str] = Field(default_factory=list)
    termination_reason: TerminationReason
    error: str | None = None


__all__ = ["EffectHistoryEntry", "RuntimeOutput", "RuntimeTraceEntry"]
