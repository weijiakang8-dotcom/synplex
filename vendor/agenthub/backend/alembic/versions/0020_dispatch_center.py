"""调度中心（二次装修）：新增 6 张表 + skills 扩展列，全部条件式幂等。

Revision ID: 0020
Revises: 0019

新增：
- routing_decisions / model_performance / usage_events /
  clarifications / savings_reports / agent_versions
- skills 扩展：source/version/status/runtime/trigger/
  model_tier_hints/times_used/last_used_at
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _add_column_if_missing(table: str, column: sa.Column) -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {col["name"] for col in inspector.get_columns(table)}
    if column.name not in columns:
        op.add_column(table, column)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())

    if "routing_decisions" not in existing:
        op.create_table(
            "routing_decisions",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "execution_id",
                sa.Uuid(),
                sa.ForeignKey("executions.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("step_id", sa.String(64), nullable=False),
            sa.Column("step_capability", sa.String(64), nullable=False),
            sa.Column("score", sa.Float(), nullable=False),
            sa.Column("tier", sa.String(16), nullable=False),
            sa.Column("chosen_complexity", sa.String(16), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("factors", sa.JSON(), nullable=True),
            sa.Column("candidates", sa.JSON(), nullable=True),
            sa.Column("outcome", sa.String(16), nullable=True),
            sa.Column("model_used", sa.String(128), nullable=True),
            sa.Column("cost", sa.Float(), nullable=True),
            sa.Column(
                "organization_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
        op.create_index(
            "ix_routing_decisions_execution_id",
            "routing_decisions",
            ["execution_id"],
        )
        op.create_index(
            "ix_routing_decisions_organization_id",
            "routing_decisions",
            ["organization_id"],
        )

    if "model_performance" not in existing:
        op.create_table(
            "model_performance",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "organization_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("model", sa.String(128), nullable=False),
            sa.Column("task_type", sa.String(64), nullable=False),
            sa.Column("bucket", sa.String(16), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("successes", sa.Integer(), nullable=False),
            sa.Column("total_cost", sa.Float(), nullable=False),
            sa.Column("avg_latency_ms", sa.Float(), nullable=False),
            sa.UniqueConstraint(
                "organization_id",
                "model",
                "task_type",
                "bucket",
                name="uq_model_performance_org_model_task_bucket",
            ),
        )
        op.create_index(
            "ix_model_performance_organization_id",
            "model_performance",
            ["organization_id"],
        )
        op.create_index("ix_model_performance_model", "model_performance", ["model"])

    if "usage_events" not in existing:
        op.create_table(
            "usage_events",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "execution_id",
                sa.Uuid(),
                sa.ForeignKey("executions.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "user_id",
                sa.Uuid(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "organization_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("task_type", sa.String(64), nullable=False),
            sa.Column("step_capability", sa.String(64), nullable=False),
            sa.Column("complexity", sa.String(16), nullable=False),
            sa.Column("model", sa.String(128), nullable=True),
            sa.Column("input_tokens", sa.Integer(), nullable=False),
            sa.Column("output_tokens", sa.Integer(), nullable=False),
            sa.Column("cost", sa.Float(), nullable=True),
            sa.Column("latency_ms", sa.Float(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
        )
        op.create_index(
            "ix_usage_events_execution_id", "usage_events", ["execution_id"]
        )
        op.create_index("ix_usage_events_user_id", "usage_events", ["user_id"])
        op.create_index(
            "ix_usage_events_organization_id", "usage_events", ["organization_id"]
        )

    if "clarifications" not in existing:
        op.create_table(
            "clarifications",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "execution_id",
                sa.Uuid(),
                sa.ForeignKey("executions.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("step_id", sa.String(64), nullable=False),
            sa.Column("question", sa.Text(), nullable=False),
            sa.Column("options", sa.JSON(), nullable=True),
            sa.Column("answer", sa.Text(), nullable=True),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column(
                "organization_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index(
            "ix_clarifications_execution_id", "clarifications", ["execution_id"]
        )
        op.create_index(
            "ix_clarifications_organization_id", "clarifications", ["organization_id"]
        )

    if "savings_reports" not in existing:
        op.create_table(
            "savings_reports",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "organization_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
            sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
            sa.Column("baseline_cost", sa.Float(), nullable=False),
            sa.Column("actual_cost", sa.Float(), nullable=False),
            sa.Column("savings", sa.Float(), nullable=False),
            sa.Column("savings_rate", sa.Float(), nullable=False),
            sa.Column("total_tokens", sa.Integer(), nullable=False),
            sa.Column("details", sa.JSON(), nullable=True),
        )
        op.create_index(
            "ix_savings_reports_organization_id", "savings_reports", ["organization_id"]
        )

    if "agent_versions" not in existing:
        op.create_table(
            "agent_versions",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("name", sa.String(64), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("role", sa.String(64), nullable=False),
            sa.Column("system_prompt", sa.Text(), nullable=False),
            sa.Column("model_policy", sa.JSON(), nullable=True),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("metrics", sa.JSON(), nullable=True),
            sa.Column("change_note", sa.Text(), nullable=False),
            sa.Column(
                "organization_id",
                sa.Uuid(),
                sa.ForeignKey("organizations.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_agent_versions_name", "agent_versions", ["name"])
        op.create_index(
            "ix_agent_versions_organization_id", "agent_versions", ["organization_id"]
        )

    # —— skills 扩展列（条件式，缺哪列补哪列）——
    _add_column_if_missing(
        "skills",
        sa.Column("source", sa.String(16), nullable=False, server_default="user"),
    )
    _add_column_if_missing(
        "skills", sa.Column("version", sa.Integer(), nullable=False, server_default="1")
    )
    _add_column_if_missing(
        "skills",
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
    )
    _add_column_if_missing(
        "skills",
        sa.Column("runtime", sa.String(16), nullable=False, server_default="kernel"),
    )
    _add_column_if_missing(
        "skills", sa.Column("trigger", sa.Text(), nullable=False, server_default="")
    )
    _add_column_if_missing(
        "skills", sa.Column("model_tier_hints", sa.JSON(), nullable=True)
    )
    _add_column_if_missing(
        "skills",
        sa.Column("times_used", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_column_if_missing(
        "skills", sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = set(inspector.get_table_names())
    for table in (
        "agent_versions",
        "savings_reports",
        "clarifications",
        "usage_events",
        "model_performance",
        "routing_decisions",
    ):
        if table in existing:
            op.drop_table(table)

    skill_cols = (
        {col["name"] for col in inspector.get_columns("skills")}
        if "skills" in existing
        else set()
    )
    for column in (
        "source",
        "version",
        "status",
        "runtime",
        "trigger",
        "model_tier_hints",
        "times_used",
        "last_used_at",
    ):
        if column in skill_cols:
            op.drop_column("skills", column)
