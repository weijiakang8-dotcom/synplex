"""用户反馈表（仅站主可见）。

Revision ID: 0021
Revises: 0020
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "feedback" not in inspector.get_table_names():
        op.create_table(
            "feedback",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("contact", sa.String(200), nullable=False),
            sa.Column("ip_address", sa.String(64), nullable=False),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "feedback" in inspector.get_table_names():
        op.drop_table("feedback")
