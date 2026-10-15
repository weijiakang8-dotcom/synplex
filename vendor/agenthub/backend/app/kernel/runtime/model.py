from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.artifact.store import ArtifactStore
from app.kernel.capability.registry import CapabilityRegistry
from app.kernel.goal.model import Goal
from app.kernel.plan.model import Plan
from app.kernel.state.model import State


class TerminationReason(StrEnum):
    TERMINATED_GOAL_SATISFIED = "TERMINATED_GOAL_SATISFIED"
    TERMINATED_NO_PATH = "TERMINATED_NO_PATH"
    TERMINATED_RETRY_EXHAUSTED = "TERMINATED_RETRY_EXHAUSTED"
    TERMINATED_UNKNOWN_EFFECT = "TERMINATED_UNKNOWN_EFFECT"
    TERMINATED_MAX_STEPS = "TERMINATED_MAX_STEPS"
    TERMINATED_ERROR = "TERMINATED_ERROR"


class RuntimeInput(BaseModel):
    """Kernel Runtime 的一次确定性输入。"""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    initial_state: State
    plan: Plan
    goal: Goal
    capability_registry: CapabilityRegistry
    artifact_store: ArtifactStore
    effect_port: Any
    max_steps: int = Field(default=100, ge=1)


__all__ = ["RuntimeInput", "TerminationReason"]
