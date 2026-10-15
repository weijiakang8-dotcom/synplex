"""add execution usage columns

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-15

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "executions",
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "executions",
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "executions",
        sa.Column("cost", sa.Float(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("executions", "cost")
    op.drop_column("executions", "output_tokens")
    op.drop_column("executions", "input_tokens")
