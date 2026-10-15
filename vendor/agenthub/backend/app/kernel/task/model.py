from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.capability.model import CapabilityId, Predicate


class Task(BaseModel):
    """Capability Contract 的一次实例。不包含 Agent/Role/Prompt/Model/Workflow。"""

    model_config = ConfigDict(frozen=True)

    task_id: str
    capability_id: CapabilityId
    input_artifacts: list[str] = Field(default_factory=list)
    input_arguments: dict[str, Any] = Field(default_factory=dict)
    expected_output: dict[str, Any] = Field(default_factory=dict)
    preconditions: list[Predicate] = Field(default_factory=list)
    postconditions: list[Predicate] = Field(default_factory=list)
    constraints: dict[str, Any] = Field(default_factory=dict)


__all__ = ["Task"]
