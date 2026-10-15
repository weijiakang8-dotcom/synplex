"""add execution event contract fields

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-17

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("executions", sa.Column("correlation_id", sa.Uuid(), nullable=True))
    op.add_column(
        "executions",
        sa.Column(
            "event_sequence",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.execute(
        "UPDATE executions SET correlation_id = gen_random_uuid() "
        "WHERE correlation_id IS NULL"
    )
    op.alter_column(
        "executions",
        "correlation_id",
        existing_type=sa.Uuid(),
        nullable=False,
    )


def downgrade() -> None:
    op.drop_column("executions", "event_sequence")
    op.drop_column("executions", "correlation_id")
