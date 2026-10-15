from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.effects.command import Command
from app.kernel.state.model import (
    ExecutionReceipt,
    KnowledgeState,
    Observation,
)


class CapabilityId(StrEnum):
    RETRIEVE = "retrieve"
    EXTRACT = "extract"
    COMPUTE = "compute"
    VALIDATE = "validate"
    REASON = "reason"
    SYNTHESIZE = "synthesize"
    OBSERVE = "observe"
    MUTATE = "mutate"


class Classification(StrEnum):
    PURE = "PURE"
    EFFECTFUL = "EFFECTFUL"


class SideEffectPolicy(StrEnum):
    NONE = "NONE"
    COMMAND_REQUIRED = "COMMAND_REQUIRED"
    OBSERVATION_REQUIRED = "OBSERVATION_REQUIRED"


class CapabilityOutcome(StrEnum):
    APPLIED = "APPLIED"
    PRECONDITION_FAILED = "PRECONDITION_FAILED"
    POSTCONDITION_FAILED = "POSTCONDITION_FAILED"


class Predicate(BaseModel):
    """确定性、无副作用的命名谓词。"""

    model_config = ConfigDict(frozen=True)

    name: str
    params: dict[str, Any] = Field(default_factory=dict)


class CapabilityDefinition(BaseModel):
    """Capability 的机器可读契约。"""

    model_config = ConfigDict(frozen=True)

    capability_id: CapabilityId
    classification: Classification
    input_contract: dict[str, Any] = Field(default_factory=dict)
    output_contract: dict[str, Any] = Field(default_factory=dict)
    preconditions: list[Predicate] = Field(default_factory=list)
    postconditions: list[Predicate] = Field(default_factory=list)
    determinism: bool = True
    side_effect_policy: SideEffectPolicy


class CapabilityResult(BaseModel):
    """Capability 边界执行后的类型化结果。"""

    model_config = ConfigDict(frozen=True)

    capability_id: CapabilityId
    classification: Classification
    outcome: CapabilityOutcome
    knowledge: KnowledgeState | None = None
    command: Command | None = None
    receipt: ExecutionReceipt | None = None
    observation: Observation | None = None
    error: str | None = None


__all__ = [
    "CapabilityDefinition",
    "CapabilityId",
    "CapabilityOutcome",
    "CapabilityResult",
    "Classification",
    "Predicate",
    "SideEffectPolicy",
]
