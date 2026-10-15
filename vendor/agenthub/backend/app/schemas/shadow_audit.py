from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ShadowAuditView(BaseModel):
    """Shadow Audit 只读 DTO；不是 ORM Model，也不是 Kernel State。"""

    model_config = ConfigDict(frozen=True)

    audit_id: uuid.UUID
    execution_id: uuid.UUID
    workflow_id: uuid.UUID | None
    shadow_status: str
    kernel_termination: str | None
    kernel_goal_status: str | None
    evidence_level: str | None
    semantic_match: bool | None
    information_loss: list
    violations: list
    trace: list
    error_type: str | None
    error_message: str | None
    created_at: datetime


__all__ = ["ShadowAuditView"]
