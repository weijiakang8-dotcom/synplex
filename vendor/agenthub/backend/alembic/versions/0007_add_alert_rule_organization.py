"""add alert rule organization

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-16

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    op.add_column(
        "alert_rules",
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute(
        f"UPDATE alert_rules SET organization_id = '{DEFAULT_ORG_ID}' "
        "WHERE organization_id IS NULL"
    )
    op.create_index(
        "ix_alert_rules_organization_id",
        "alert_rules",
        ["organization_id"],
    )
    op.create_foreign_key(
        "fk_alert_rules_organization_id",
        "alert_rules",
        "organizations",
        ["organization_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_alert_rules_organization_id",
        "alert_rules",
        type_="foreignkey",
    )
    op.drop_index("ix_alert_rules_organization_id", table_name="alert_rules")
    op.drop_column("alert_rules", "organization_id")
