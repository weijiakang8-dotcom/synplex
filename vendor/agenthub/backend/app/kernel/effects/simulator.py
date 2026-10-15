from __future__ import annotations

from enum import StrEnum

from app.kernel.effects.command import Command
from app.kernel.effects.receipt import ExecutionReceipt, ReceiptStatus
from app.kernel.evidence.model import EvidenceLevel
from app.kernel.state.model import Observation


class WorldOutcome(StrEnum):
    SUCCESS = "SUCCESS"
    TIMEOUT_BUT_COMMITTED = "TIMEOUT_BUT_COMMITTED"
    TIMEOUT_NOT_COMMITTED = "TIMEOUT_NOT_COMMITTED"
    UNKNOWN_RESULT = "UNKNOWN_RESULT"
    DUPLICATE_REQUEST = "DUPLICATE_REQUEST"


class DeterministicWorldSimulator:
    """内存态确定性外部世界模拟器。无随机、无真实时钟、无网络。"""

    def __init__(self) -> None:
        self._world: dict[str, bool | None] = {}

    def execute(self, command: Command, outcome: WorldOutcome) -> ExecutionReceipt:
        key = command.idempotency_key
        if self._world.get(key) is True:
            return self._receipt(
                command,
                ReceiptStatus.DUPLICATE,
                external_reference=f"dedup:{key}",
            )

        if outcome == WorldOutcome.SUCCESS:
            self._world[key] = True
            return self._receipt(
                command,
                ReceiptStatus.SUCCESS,
                external_reference=f"ext:{command.command_id}",
            )
        if outcome == WorldOutcome.TIMEOUT_BUT_COMMITTED:
            self._world[key] = True
            return self._receipt(command, ReceiptStatus.TIMEOUT)
        if outcome == WorldOutcome.TIMEOUT_NOT_COMMITTED:
            self._world[key] = False
            return self._receipt(command, ReceiptStatus.TIMEOUT)
        if outcome == WorldOutcome.UNKNOWN_RESULT:
            self._world[key] = None
            return self._receipt(command, ReceiptStatus.UNKNOWN)
        if outcome == WorldOutcome.DUPLICATE_REQUEST:
            self._world[key] = True
            return self._receipt(
                command,
                ReceiptStatus.DUPLICATE,
                external_reference=f"dedup:{key}",
            )
        raise ValueError(f"unknown world outcome: {outcome}")

    def observe(self, command: Command) -> Observation:
        key = command.idempotency_key
        committed = self._world.get(key, False)
        return Observation(
            observation_id=f"observation:{command.command_id}",
            source="deterministic-simulator",
            observed_at="",
            external_state={
                "committed": committed,
                "capability_id": command.capability_id,
            },
            evidence_level=EvidenceLevel.L3_OBSERVED,
        )

    def committed_keys(self) -> list[str]:
        return sorted(
            key for key, committed in self._world.items() if committed is True
        )

    def _receipt(
        self,
        command: Command,
        status: ReceiptStatus,
        *,
        external_reference: str | None = None,
    ) -> ExecutionReceipt:
        return ExecutionReceipt(
            receipt_id=f"receipt:{command.command_id}",
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            status=status,
            attempted_at=command.created_at_logical,
            completed_at=command.created_at_logical,
            external_reference=external_reference,
        )


__all__ = ["DeterministicWorldSimulator", "WorldOutcome"]
