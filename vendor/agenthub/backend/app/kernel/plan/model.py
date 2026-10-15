from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.task.model import Task


class Dependency(BaseModel):
    model_config = ConfigDict(frozen=True)

    task_id: str
    on_task_id: str


class ExpectedTransition(BaseModel):
    model_config = ConfigDict(frozen=True)

    from_state_hash: str | None = None
    to_state_hash: str | None = None
    assertion: str | None = None


class Plan(BaseModel):
    """State Transition Path。不绑定 Agent/Role/Prompt/Model。"""

    model_config = ConfigDict(frozen=True)

    plan_id: str
    tasks: list[Task]
    dependencies: list[Dependency] = Field(default_factory=list)
    initial_state_ref: str = ""
    expected_transition: ExpectedTransition | None = None
    constraints: dict[str, Any] = Field(default_factory=dict)


class PlanValidationResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    valid: bool
    issues: list[str] = Field(default_factory=list)


__all__ = [
    "Dependency",
    "ExpectedTransition",
    "Plan",
    "PlanValidationResult",
]
