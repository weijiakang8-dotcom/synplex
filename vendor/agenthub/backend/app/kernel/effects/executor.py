from __future__ import annotations

from app.kernel.effects.command import Command
from app.kernel.effects.dedup import DeduplicationProofArtifact
from app.kernel.effects.receipt import ExecutionReceipt
from app.kernel.effects.reconciliation import (
    ReconciliationResult,
    reconcile,
)
from app.kernel.effects.retry import RetryPolicy
from app.kernel.effects.simulator import (
    DeterministicWorldSimulator,
    WorldOutcome,
)
from app.kernel.state.model import Observation


class EffectExecutor:
    """驱动 Command → Receipt → Observe → Observation → Reconciliation 的生命周期。"""

    def __init__(
        self,
        simulator: DeterministicWorldSimulator,
        retry_policy: RetryPolicy,
    ) -> None:
        self._simulator = simulator
        self._retry_policy = retry_policy

    def execute(self, command: Command, outcome: WorldOutcome) -> ExecutionReceipt:
        return self._simulator.execute(command, outcome)

    def observe(self, command: Command) -> Observation:
        return self._simulator.observe(command)

    def reconcile(
        self,
        receipt: ExecutionReceipt,
        observation: Observation,
    ) -> ReconciliationResult:
        return reconcile(receipt, observation)

    def build_retry_command(self, original: Command, attempt: int) -> Command:
        return self._retry_policy.build_retry_command(original, attempt)

    def can_retry(self, attempt_count: int) -> bool:
        return self._retry_policy.eligible(attempt_count)

    def retry_eligible(
        self,
        result: ReconciliationResult,
        attempt_count: int,
    ) -> bool:
        """只有 CONFIRMED_NOT_COMMITTED 且未达上限才允许 retry。"""
        return (
            result == ReconciliationResult.CONFIRMED_NOT_COMMITTED
            and self.can_retry(attempt_count)
        )

    def build_dedup_proof(
        self,
        original: Command,
        retry: Command | None,
        observation: Observation,
        result: ReconciliationResult,
    ) -> DeduplicationProofArtifact:
        return DeduplicationProofArtifact(
            idempotency_key=original.idempotency_key,
            original_command_id=original.command_id,
            retry_command_id=retry.command_id if retry is not None else None,
            deduplication_result=result.value,
            evidence={
                "observation_id": observation.observation_id,
                "external_state": observation.external_state,
            },
        )


__all__ = ["EffectExecutor"]
