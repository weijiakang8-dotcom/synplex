"""add intervention, alerting and dag definition

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-13

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workflows", sa.Column("dag_definition", sa.JSON(), nullable=True))

    op.create_table(
        "intervention_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("operator", sa.String(255), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("modified_plan", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_intervention_logs_execution_id", "intervention_logs", ["execution_id"]
    )
    op.create_foreign_key(
        "fk_intervention_logs_execution_id",
        "intervention_logs",
        "executions",
        ["execution_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.create_table(
        "alert_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("rule_id", sa.String(100), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column(
            "triggered_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("alert_events")
    op.drop_constraint(
        "fk_intervention_logs_execution_id", "intervention_logs", type_="foreignkey"
    )
    op.drop_index("ix_intervention_logs_execution_id", table_name="intervention_logs")
    op.drop_table("intervention_logs")
    op.drop_column("workflows", "dag_definition")
