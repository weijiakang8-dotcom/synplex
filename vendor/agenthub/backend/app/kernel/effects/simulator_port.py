from __future__ import annotations

from app.kernel.effects.command import Command
from app.kernel.effects.port import EffectResult
from app.kernel.effects.receipt import ReceiptStatus
from app.kernel.effects.retry import RetryPolicy
from app.kernel.effects.simulator import (
    DeterministicWorldSimulator,
    WorldOutcome,
)

_STATUS_MAP = {
    ReceiptStatus.SUCCESS: "success",
    ReceiptStatus.TIMEOUT: "timeout",
    ReceiptStatus.FAILED: "error",
    ReceiptStatus.UNKNOWN: "unknown",
    ReceiptStatus.DUPLICATE: "duplicate",
    ReceiptStatus.PENDING: "error",
}


class SimulatorEffectPort:
    """把 DeterministicWorldSimulator 适配为 EffectPort。默认路径。"""

    def __init__(
        self,
        simulator: DeterministicWorldSimulator,
        retry_policy: RetryPolicy,
    ) -> None:
        self._simulator = simulator
        self._retry_policy = retry_policy

    def execute_effect(self, command: Command) -> EffectResult:
        outcome = WorldOutcome(command.payload.get("world_outcome", "SUCCESS"))
        receipt = self._simulator.execute(command, outcome)
        observation = self._simulator.observe(command)
        committed = observation.external_state.get("committed")
        return EffectResult(
            status=_STATUS_MAP[receipt.status],
            committed=committed,
            external_reference=receipt.external_reference,
            raw_response=observation.external_state,
        )

    def query_effect(
        self,
        command: Command,
        external_reference: str | None = None,
    ) -> EffectResult:
        observation = self._simulator.observe(command)
        committed = observation.external_state.get("committed")
        return EffectResult(
            status="success",
            committed=committed,
            external_reference=None,
            raw_response=observation.external_state,
        )

    def can_retry(self, attempt_count: int) -> bool:
        return self._retry_policy.eligible(attempt_count)

    def build_retry_command(self, original: Command, attempt: int) -> Command:
        return self._retry_policy.build_retry_command(original, attempt)


__all__ = ["SimulatorEffectPort"]
