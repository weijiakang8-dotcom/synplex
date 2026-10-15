"""Add execution lease fields and transactional outbox.

Revision ID: 0023
Revises: 0022
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("executions", sa.Column("lease_owner", sa.String(255), nullable=True))
    op.add_column(
        "executions",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "executions",
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "executions",
        sa.Column("run_attempt", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_index(
        "ix_executions_active_lease",
        "executions",
        ["status", "lease_expires_at"],
    )
    op.create_table(
        "outbox_events",
        sa.Column("execution_id", sa.Uuid(), nullable=True),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(1000), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["execution_id"], ["executions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_outbox_events_pending", "outbox_events", ["published_at", "available_at"]
    )
    op.create_index(
        "ix_outbox_events_execution", "outbox_events", ["execution_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_outbox_events_execution", table_name="outbox_events")
    op.drop_index("ix_outbox_events_pending", table_name="outbox_events")
    op.drop_table("outbox_events")
    op.drop_index("ix_executions_active_lease", table_name="executions")
    op.drop_column("executions", "run_attempt")
    op.drop_column("executions", "heartbeat_at")
    op.drop_column("executions", "lease_expires_at")
    op.drop_column("executions", "lease_owner")
