"""add shadow audit organization

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-17

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "shadow_audits",
        sa.Column("organization_id", sa.Uuid(), nullable=True),
    )
    op.create_index(
        "ix_shadow_audits_organization_id",
        "shadow_audits",
        ["organization_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_shadow_audits_organization_id", table_name="shadow_audits")
    op.drop_column("shadow_audits", "organization_id")
