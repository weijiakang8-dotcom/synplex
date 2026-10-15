from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.artifact.model import ArtifactRef
from app.kernel.effects.receipt import ExecutionReceipt
from app.kernel.evidence.model import EvidenceLevel


class KnowledgeKind(StrEnum):
    FACT = "FACT"
    HYPOTHESIS = "HYPOTHESIS"
    PREDICTION = "PREDICTION"
    PLAN = "PLAN"
    CANDIDATE_ARTIFACT = "CANDIDATE_ARTIFACT"
    DERIVED_ARTIFACT = "DERIVED_ARTIFACT"


class KnowledgeEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    kind: KnowledgeKind
    statement: str
    evidence_level: EvidenceLevel
    artifact_refs: list[ArtifactRef] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    confidence: float | None = None


class KnowledgeState(BaseModel):
    """模型相信的东西。可包含 Fact/Hypothesis/Prediction/Plan/Candidate/Derived。"""

    model_config = ConfigDict(frozen=True)

    entries: dict[str, KnowledgeEntry] = Field(default_factory=dict)

    def by_kind(self, kind: KnowledgeKind) -> list[KnowledgeEntry]:
        return [entry for entry in self.entries.values() if entry.kind == kind]


class Observation(BaseModel):
    """外部世界的真实观察结果；只可能是 L3 或 L4。"""

    model_config = ConfigDict(frozen=True)

    observation_id: str
    source: str
    observed_at: str
    external_state: dict[str, Any] = Field(default_factory=dict)
    evidence_level: EvidenceLevel = EvidenceLevel.L3_OBSERVED


class ObservedWorldState(BaseModel):
    """现实世界已确认的东西。只能由 Observation / Receipt 写入。"""

    model_config = ConfigDict(frozen=True)

    observations: dict[str, Observation] = Field(default_factory=dict)
    receipts: dict[str, ExecutionReceipt] = Field(default_factory=dict)


class ExecutionContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: str
    goal_ref: str | None = None
    plan_ref: str | None = None
    trace: list[str] = Field(default_factory=list)


class State(BaseModel):
    """Kernel 的核心状态值对象。三层严格分离，且是不可变值对象。"""

    model_config = ConfigDict(frozen=True)

    knowledge: KnowledgeState = Field(default_factory=KnowledgeState)
    observed: ObservedWorldState = Field(default_factory=ObservedWorldState)
    context: ExecutionContext


__all__ = [
    "ExecutionContext",
    "ExecutionReceipt",
    "KnowledgeEntry",
    "KnowledgeKind",
    "KnowledgeState",
    "Observation",
    "ObservedWorldState",
    "State",
]
