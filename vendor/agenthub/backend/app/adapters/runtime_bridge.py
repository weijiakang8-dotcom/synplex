from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.adapters.legacy_models import LegacyExecution, LegacyToolCall, LegacyWorkflow
from app.adapters.shadow import ShadowRunner
from app.kernel.evidence.model import EvidenceLevel


class ShadowExecutionResult(BaseModel):
    """Legacy Runtime 的 Shadow 执行结果；Kernel 失败必须被隔离。"""

    model_config = ConfigDict(frozen=True)

    shadow_status: str
    kernel_termination: str | None = None
    kernel_goal_status: str | None = None
    evidence_level: str | None = None
    semantic_match: bool | None = None
    information_loss: list[str] = Field(default_factory=list)
    violations: list[str] = Field(default_factory=list)
    trace: list[dict] = Field(default_factory=list)
    error_type: str | None = None
    error_message: str | None = None


class LegacyRuntimeBridge:
    """真实 Legacy 执行快照 → Kernel Shadow，且绝不改变 Legacy 结果。"""

    def __init__(
        self,
        shadow_enabled: bool = True,
        runner: ShadowRunner | None = None,
    ) -> None:
        self._shadow_enabled = shadow_enabled
        self._runner = runner or ShadowRunner()

    def run_shadow(
        self,
        snapshot: LegacyExecution,
        *,
        required_evidence: EvidenceLevel | None = None,
    ) -> ShadowExecutionResult:
        if not self._shadow_enabled:
            return ShadowExecutionResult(shadow_status="DISABLED")
        try:
            kernel_shadow = self._runner.run(
                snapshot,
                required_evidence=required_evidence,
            )
            return ShadowExecutionResult(
                shadow_status="SUCCESS",
                kernel_termination=kernel_shadow.kernel_termination,
                kernel_goal_status=kernel_shadow.kernel_goal_status,
                evidence_level=kernel_shadow.evidence_level,
                semantic_match=kernel_shadow.semantic_match,
                information_loss=kernel_shadow.information_loss,
                violations=kernel_shadow.violations,
                trace=kernel_shadow.trace,
            )
        except Exception as exc:  # noqa: BLE001
            return ShadowExecutionResult(
                shadow_status="FAILED",
                error_type=type(exc).__name__,
                error_message=str(exc),
            )


def build_legacy_snapshot(
    *,
    execution_id: str,
    user_input: str,
    final_output: str | None,
    status: str,
    workflow_name: str,
    agent_chain: list[str] | None = None,
    tool_calls: list[dict] | None = None,
) -> LegacyExecution:
    """把真实 Legacy 记录（SQLAlchemy 只读投影）冻结为 Legacy DTO。"""
    return LegacyExecution(
        execution_id=execution_id,
        workflow=LegacyWorkflow(name=workflow_name, agent_chain=agent_chain or []),
        user_input=user_input,
        final_output=final_output,
        status=status,
        tool_calls=[LegacyToolCall(**tool_call) for tool_call in (tool_calls or [])],
    )


def run_shadow_after_execution(
    *,
    execution_id: str,
    user_input: str,
    final_output: str | None,
    status: str,
    workflow_name: str,
    agent_chain: list[str] | None = None,
    tool_calls: list[dict] | None = None,
    enabled: bool = True,
    required_evidence: EvidenceLevel | None = None,
) -> ShadowExecutionResult:
    """Legacy 主链路在结果回写前可调用的最小 Shadow Hook。"""
    bridge = LegacyRuntimeBridge(shadow_enabled=enabled)
    snapshot = build_legacy_snapshot(
        execution_id=execution_id,
        user_input=user_input,
        final_output=final_output,
        status=status,
        workflow_name=workflow_name,
        agent_chain=agent_chain,
        tool_calls=tool_calls,
    )
    return bridge.run_shadow(snapshot, required_evidence=required_evidence)


__all__ = [
    "LegacyRuntimeBridge",
    "ShadowExecutionResult",
    "build_legacy_snapshot",
    "run_shadow_after_execution",
]
