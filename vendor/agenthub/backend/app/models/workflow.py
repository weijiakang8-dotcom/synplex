from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Enum, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import WorkflowStatus

if TYPE_CHECKING:
    from app.models.execution import Execution


class Workflow(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Workflow（工作流）定义。"""

    __tablename__ = "workflows"

    name: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 参与该工作流的 Agent ID 列表及执行顺序（DAG 结构）
    agent_chain: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    dag_definition: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[WorkflowStatus] = mapped_column(
        Enum(
            WorkflowStatus,
            name="workflow_status",
            values_callable=lambda enum_cls: [item.value for item in enum_cls],
        ),
        nullable=False,
        default=WorkflowStatus.DRAFT,
    )
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    executions: Mapped[list[Execution]] = relationship(
        back_populates="workflow", cascade="all, delete-orphan", lazy="selectin"
    )
