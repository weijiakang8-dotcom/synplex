from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Command(BaseModel):
    """Effectful 操作的正式意图。"""

    model_config = ConfigDict(frozen=True)

    command_id: str
    idempotency_key: str
    capability_id: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at_logical: int = 0


__all__ = ["Command"]
