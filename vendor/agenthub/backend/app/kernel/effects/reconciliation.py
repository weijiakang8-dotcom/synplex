from __future__ import annotations

from enum import StrEnum

from app.kernel.effects.receipt import ExecutionReceipt, ReceiptStatus
from app.kernel.state.model import Observation


class ReconciliationResult(StrEnum):
    CONFIRMED_COMMITTED = "CONFIRMED_COMMITTED"
    CONFIRMED_NOT_COMMITTED = "CONFIRMED_NOT_COMMITTED"
    STILL_UNKNOWN = "STILL_UNKNOWN"
    DUPLICATE_CONFIRMED = "DUPLICATE_CONFIRMED"


def reconcile(
    receipt: ExecutionReceipt,
    observation: Observation,
) -> ReconciliationResult:
    committed = observation.external_state.get("committed")
    if committed is True:
        if receipt.status == ReceiptStatus.DUPLICATE:
            return ReconciliationResult.DUPLICATE_CONFIRMED
        return ReconciliationResult.CONFIRMED_COMMITTED
    if committed is False:
        return ReconciliationResult.CONFIRMED_NOT_COMMITTED
    return ReconciliationResult.STILL_UNKNOWN


__all__ = ["ReconciliationResult", "reconcile"]
