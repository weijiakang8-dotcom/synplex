import uuid

from sqlalchemy import JSON, Boolean, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ShadowAuditRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Shadow 旁路审计记录。不是 Kernel State / Observation / Receipt / Goal。"""

    __tablename__ = "shadow_audits"

    execution_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, nullable=True, index=True
    )
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, nullable=True, index=True
    )
    shadow_status: Mapped[str] = mapped_column(String(40), nullable=False)
    kernel_termination: Mapped[str | None] = mapped_column(String(80), nullable=True)
    kernel_goal_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    evidence_level: Mapped[str | None] = mapped_column(String(40), nullable=True)
    semantic_match: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    information_loss: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    violations: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    trace: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    error_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


__all__ = ["ShadowAuditRecord"]
