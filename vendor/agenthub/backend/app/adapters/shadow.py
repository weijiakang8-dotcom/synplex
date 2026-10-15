from __future__ import annotations

from app.adapters.execution_adapter import LegacyExecutionAdapter
from app.adapters.legacy_models import LegacyExecution
from app.adapters.result_adapter import KernelShadowResult, LegacyResultAdapter
from app.kernel.capability.contracts import build_standard_registry
from app.kernel.effects.retry import RetryPolicy
from app.kernel.effects.simulator import DeterministicWorldSimulator
from app.kernel.effects.simulator_port import SimulatorEffectPort
from app.kernel.evidence.model import EvidenceLevel
from app.kernel.goal.model import Goal
from app.kernel.runtime.loop import KernelRuntime


class ShadowRunner:
    """SHADOW MODE：Legacy 数据不动，Kernel 用同一输入并行运行并产生审计结果。"""

    def __init__(self) -> None:
        self._adapter = LegacyExecutionAdapter()
        self._result_adapter = LegacyResultAdapter()
        self._runtime = KernelRuntime()

    def run(
        self,
        legacy: LegacyExecution,
        *,
        goal: Goal | None = None,
        required_evidence: EvidenceLevel | None = None,
    ) -> KernelShadowResult:
        store = self._adapter.build_artifact_store(legacy)
        registry = build_standard_registry()
        simulator = DeterministicWorldSimulator()
        executor = SimulatorEffectPort(simulator, RetryPolicy(max_retries=1))

        if goal is None and required_evidence is not None:
            goal = self._adapter.to_goal_for_legacy(
                legacy,
                required_evidence=required_evidence,
            )

        runtime_input = self._adapter.to_runtime_input(
            legacy,
            registry=registry,
            store=store,
            executor=executor,
            goal=goal,
        )
        output = self._runtime.run(runtime_input)
        return self._result_adapter.build_shadow(legacy, output)


__all__ = ["ShadowRunner"]
