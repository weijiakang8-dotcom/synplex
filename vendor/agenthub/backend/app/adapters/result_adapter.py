from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.adapters.legacy_models import LegacyExecution
from app.kernel.evidence.model import max_evidence_level
from app.kernel.runtime.result import RuntimeOutput


class LegacyResultRecord(BaseModel):
    model_config = ConfigDict(frozen=True)

    legacy_status: str
    kernel_goal_status: str
    kernel_termination: str
    final_output_ref: str | None = None
    note: str = "legacy COMPLETED != kernel SATISFIED"


class KernelShadowResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    legacy_status: str
    kernel_termination: str
    legacy_output_ref: str | None
    kernel_goal_status: str
    evidence_level: str
    semantic_match: bool
    information_loss: list[str] = Field(default_factory=list)
    violations: list[str] = Field(default_factory=list)
    trace: list[dict] = Field(default_factory=list)


class LegacyResultAdapter:
    def to_legacy_result(
        self,
        legacy: LegacyExecution,
        output: RuntimeOutput,
    ) -> LegacyResultRecord:
        return LegacyResultRecord(
            legacy_status=legacy.status,
            kernel_goal_status=output.goal_result.status.value,
            kernel_termination=output.termination_reason.value,
            final_output_ref=("legacy_final_output" if legacy.final_output else None),
        )

    def build_shadow(
        self,
        legacy: LegacyExecution,
        output: RuntimeOutput,
    ) -> KernelShadowResult:
        levels = [
            entry.evidence_level
            for entry in output.final_state.knowledge.entries.values()
        ]
        levels += [
            observation.evidence_level
            for observation in output.final_state.observed.observations.values()
        ]
        evidence = max_evidence_level(levels).value

        legacy_completed = legacy.status == "completed"
        kernel_satisfied = output.goal_result.status.value == "SATISFIED"
        violations: list[str] = []

        return KernelShadowResult(
            legacy_status=legacy.status,
            kernel_termination=output.termination_reason.value,
            legacy_output_ref=("legacy_final_output" if legacy.final_output else None),
            kernel_goal_status=output.goal_result.status.value,
            evidence_level=evidence,
            semantic_match=legacy_completed == kernel_satisfied,
            information_loss=[
                "agent identity dropped from plan",
                "final_output demoted to L1_INFERRED",
                "legacy tool success is Receipt, not Observation",
            ],
            violations=violations,
            trace=[entry.model_dump() for entry in output.execution_trace],
        )


__all__ = ["KernelShadowResult", "LegacyResultAdapter", "LegacyResultRecord"]
