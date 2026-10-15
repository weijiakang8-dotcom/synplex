"""调度中心数据模型（二次装修新增）。

闭环支撑：
- routing_decisions：每一步"为什么选这个模型"的审计事实（可解释、可回放）；
- model_performance：每个模型 × 任务类型 × 复杂度档位的成功率/成本（越用越准）；
- usage_events：每次 LLM 调用的明细（token 看板与省钱账单的数据源）；
- clarifications：执行中的歧义澄清（问题/选项/回答，不中断任务）；
- savings_reports：省钱账单（全 pro 基线 vs 实际成本）；
- agent_versions：多 Agent 的版本化提示词（自更新 + 可回滚）。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin, utcnow


class RoutingDecision(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """路由决策审计：每步选模型的事实与理由，落库可查、可回放。"""

    __tablename__ = "routing_decisions"

    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("executions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    step_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    step_capability: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    tier: Mapped[str] = mapped_column(String(16), nullable=False, default="balanced")
    chosen_complexity: Mapped[str] = mapped_column(
        String(16), nullable=False, default="simple"
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    factors: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    candidates: Mapped[list | None] = mapped_column(JSON, nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(16), nullable=True)
    model_used: Mapped[str | None] = mapped_column(String(128), nullable=True)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )


class ModelPerformance(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """模型绩效档案：越用越准的路由燃料（时间衰减由调用方处理）。"""

    __tablename__ = "model_performance"
    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "model",
            "task_type",
            "bucket",
            name="uq_model_performance_org_model_task_bucket",
        ),
    )

    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    model: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    task_type: Mapped[str] = mapped_column(String(64), nullable=False, default="task")
    bucket: Mapped[str] = mapped_column(String(16), nullable=False, default="simple")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    successes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    avg_latency_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)


class UsageEvent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """每次 LLM 调用明细：token 看板 / 省钱账单 / 自成长分析的数据源。"""

    __tablename__ = "usage_events"

    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("executions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    task_type: Mapped[str] = mapped_column(String(64), nullable=False, default="task")
    step_capability: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    complexity: Mapped[str] = mapped_column(
        String(16), nullable=False, default="simple"
    )
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    latency_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="success")


class Clarification(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """执行中的歧义澄清：弹出选项、用户选择、继续执行，全程留痕。"""

    __tablename__ = "clarifications"

    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("executions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    step_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    question: Mapped[str] = mapped_column(Text, nullable=False, default="")
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )  # pending | answered | expired
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    answered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SavingsReport(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """省钱账单：实际成本 vs 全 pro 基线，逐期可查。"""

    __tablename__ = "savings_reports"

    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    period_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    period_end: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    baseline_cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    actual_cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    savings: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    savings_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class AgentVersion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """多 Agent 提示词版本：自更新产物，激活/回滚全记录。"""

    __tablename__ = "agent_versions"

    name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    role: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    model_policy: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="candidate"
    )  # candidate | active | retired | rejected
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    change_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("organizations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    applied_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


__all__ = [
    "AgentVersion",
    "Clarification",
    "ModelPerformance",
    "RoutingDecision",
    "SavingsReport",
    "UsageEvent",
    "utcnow",
]
