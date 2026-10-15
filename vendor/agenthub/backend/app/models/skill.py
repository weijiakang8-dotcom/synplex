from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin, utcnow


class Skill(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """可复用任务模板（Skill 包）：预设 / 用户自建 / 平台自成长三种来源。

    - plan_template：计划骨架（agent runtime 格式：goal/risk/steps）。
    - model_tier_hints：每步能力 → 建议模型档位（simple/complex），由使用数据反哺。
    - version：每次自成长更新 +1，历史版本见 skill 更新审计。
    """

    __tablename__ = "skills"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    goal: Mapped[dict] = mapped_column(JSON, nullable=False)
    plan_template: Mapped[dict] = mapped_column(JSON, nullable=False)
    icon: Mapped[str] = mapped_column(String(50), nullable=False, default="sparkles")
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # —— 二次装修新增 ——
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, default="user"
    )  # preset | user | auto
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="active"
    )  # active | proposed | retired
    runtime: Mapped[str] = mapped_column(
        String(16), nullable=False, default="kernel"
    )  # kernel（旧）| agent（新调度中心）
    trigger: Mapped[str] = mapped_column(Text, nullable=False, default="")
    model_tier_hints: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    times_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


__all__ = ["Skill", "utcnow"]
