from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class ReceiptStatus(StrEnum):
    PENDING = "PENDING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    TIMEOUT = "TIMEOUT"
    UNKNOWN = "UNKNOWN"
    DUPLICATE = "DUPLICATE"


class ExecutionReceipt(BaseModel):
    """执行层面的返回结果。Receipt ≠ Observation。"""

    model_config = ConfigDict(frozen=True)

    receipt_id: str
    command_id: str
    idempotency_key: str
    status: ReceiptStatus
    attempted_at: int = 0
    completed_at: int | None = None
    external_reference: str | None = None
    error: str | None = None


__all__ = ["ExecutionReceipt", "ReceiptStatus"]
