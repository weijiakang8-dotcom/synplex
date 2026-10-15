from __future__ import annotations

import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ExecutionFeedback(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "execution_feedback"
    __table_args__ = (
        CheckConstraint(
            "rating >= 1 AND rating <= 5", name="ck_execution_feedback_rating"
        ),
    )

    execution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("executions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)


__all__ = ["ExecutionFeedback"]
