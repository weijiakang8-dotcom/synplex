"""add eval and feedback columns

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-13

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("executions", sa.Column("eval_score", sa.Float(), nullable=True))
    op.add_column("executions", sa.Column("eval_details", sa.JSON(), nullable=True))
    op.add_column("executions", sa.Column("feedback", sa.String(20), nullable=True))


def downgrade() -> None:
    op.drop_column("executions", "feedback")
    op.drop_column("executions", "eval_details")
    op.drop_column("executions", "eval_score")
