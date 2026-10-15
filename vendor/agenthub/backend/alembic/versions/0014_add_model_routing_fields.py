"""add model routing fields

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_configs",
        sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
    )
    op.add_column(
        "model_configs",
        sa.Column("timeout", sa.Integer(), nullable=False, server_default="120"),
    )
    op.add_column(
        "model_configs",
        sa.Column("max_retries", sa.Integer(), nullable=False, server_default="2"),
    )
    op.add_column(
        "model_configs",
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )


def downgrade() -> None:
    op.drop_column("model_configs", "enabled")
    op.drop_column("model_configs", "max_retries")
    op.drop_column("model_configs", "timeout")
    op.drop_column("model_configs", "priority")
