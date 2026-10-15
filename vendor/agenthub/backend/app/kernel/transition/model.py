from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.artifact.model import ArtifactRef
from app.kernel.capability.model import CapabilityId
from app.kernel.effects.command import Command
from app.kernel.state.model import ExecutionReceipt, Observation, State


class TransitionStatus(StrEnum):
    APPLIED = "APPLIED"
    PRECONDITION_FAILED = "PRECONDITION_FAILED"
    POSTCONDITION_FAILED = "POSTCONDITION_FAILED"
    INVALID_CAPABILITY = "INVALID_CAPABILITY"
    INVALID_TASK = "INVALID_TASK"


class TransitionResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    previous_state: State
    next_state: State | None
    task_id: str
    capability_id: CapabilityId
    status: TransitionStatus
    produced_artifacts: list[ArtifactRef] = Field(default_factory=list)
    command: Command | None = None
    receipt: ExecutionReceipt | None = None
    observation: Observation | None = None
    error: str | None = None


class PlanExecutionStatus(StrEnum):
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    REJECTED = "REJECTED"


class PlanExecutionResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: PlanExecutionStatus
    final_state: State
    results: list[TransitionResult] = Field(default_factory=list)
    error: str | None = None


__all__ = [
    "PlanExecutionResult",
    "PlanExecutionStatus",
    "TransitionResult",
    "TransitionStatus",
]
