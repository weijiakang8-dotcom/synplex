import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPrimaryKeyMixin, utcnow


class InterventionLog(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "intervention_logs"

    execution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("executions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    operator: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    modified_plan: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
