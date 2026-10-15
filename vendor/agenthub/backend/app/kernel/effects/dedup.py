from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class DeduplicationProofArtifact(BaseModel):
    """证明 retry 复用同一 idempotency_key 且未产生重复外部 Effect。"""

    model_config = ConfigDict(frozen=True)

    idempotency_key: str
    original_command_id: str
    retry_command_id: str | None = None
    deduplication_result: str
    evidence: dict[str, Any] = Field(default_factory=dict)


__all__ = ["DeduplicationProofArtifact"]
