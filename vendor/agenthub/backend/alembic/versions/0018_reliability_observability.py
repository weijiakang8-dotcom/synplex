"""Phase 6B：tool_calls 时间戳 + executions.cost 可空（unknown 语义）。

Revision ID: 0018
Revises: 0017
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tool_calls",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.add_column(
        "tool_calls",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.alter_column("executions", "cost", existing_type=sa.Float(), nullable=True)


def downgrade() -> None:
    op.alter_column("executions", "cost", existing_type=sa.Float(), nullable=False)
    op.drop_column("tool_calls", "updated_at")
    op.drop_column("tool_calls", "created_at")
