from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import ToolCallStatus

if TYPE_CHECKING:
    from app.models.execution import Execution


class ToolCall(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """ToolCall（工具调用审计日志）。"""

    __tablename__ = "tool_calls"

    execution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("executions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    tool_name: Mapped[str] = mapped_column(String(255), nullable=False)
    input_params: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    output_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[ToolCallStatus] = mapped_column(
        Enum(
            ToolCallStatus,
            name="tool_call_status",
            values_callable=lambda enum_cls: [item.value for item in enum_cls],
        ),
        nullable=False,
        default=ToolCallStatus.PENDING,
    )
    requires_approval: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    idempotency_key: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    approved_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    execution: Mapped[Execution] = relationship(
        back_populates="tool_calls", lazy="selectin"
    )
