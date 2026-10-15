from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import ExecutionStatus

if TYPE_CHECKING:
    from app.models.tool_call import ToolCall
    from app.models.workflow import Workflow


class Execution(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Execution（工作流实例/运行记录）。"""

    __tablename__ = "executions"

    workflow_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("workflows.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    workflow_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("workflow_versions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    status: Mapped[ExecutionStatus] = mapped_column(
        Enum(
            ExecutionStatus,
            name="execution_status",
            values_callable=lambda enum_cls: [item.value for item in enum_cls],
        ),
        nullable=False,
        default=ExecutionStatus.PENDING,
    )
    current_step_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    correlation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        nullable=False,
        default=uuid.uuid4,
    )
    event_sequence: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    lease_owner: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    run_attempt: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    # LangGraph 的 Checkpoint 状态快照，开始运行前可为空
    checkpoint_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    intent: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    plan: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 本次执行实际采用的模型选择：{provider, model, reasoning_effort}。
    model_selection: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    user_input: Mapped[str] = mapped_column(Text, nullable=False)
    # 聊天场景注入的历史上下文（已按角色与长度截断），与当前 user_input 分离存储。
    context_messages: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    final_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    eval_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    eval_details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    feedback: Mapped[str | None] = mapped_column(String(20), nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    steps: Mapped[list | None] = mapped_column(JSON, nullable=True)
    token_usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    model_used: Mapped[list | None] = mapped_column(JSON, nullable=True)

    workflow: Mapped[Workflow] = relationship(
        back_populates="executions", lazy="selectin"
    )
    tool_calls: Mapped[list[ToolCall]] = relationship(
        back_populates="execution", cascade="all, delete-orphan", lazy="selectin"
    )
