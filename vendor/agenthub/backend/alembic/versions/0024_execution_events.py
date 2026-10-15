"""Add durable execution events.

Revision ID: 0024_execution_events
Revises: 0023
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0024_execution_events"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "execution_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["execution_id"], ["executions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "execution_id", "sequence", name="uq_execution_event_sequence"
        ),
    )
    op.create_index(
        "ix_execution_events_execution_sequence",
        "execution_events",
        ["execution_id", "sequence"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_execution_events_execution_sequence", table_name="execution_events"
    )
    op.drop_table("execution_events")
