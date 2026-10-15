"""add audit log action fields

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-16

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008_full_schema_backfill"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "audit_logs", sa.Column("action", sa.String(length=80), nullable=True)
    )
    op.add_column(
        "audit_logs", sa.Column("resource_type", sa.String(length=80), nullable=True)
    )
    op.add_column(
        "audit_logs", sa.Column("resource_id", sa.String(length=120), nullable=True)
    )
    op.add_column(
        "audit_logs", sa.Column("ip_address", sa.String(length=64), nullable=True)
    )
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_resource_type", "audit_logs", ["resource_type"])


def downgrade() -> None:
    op.drop_index("ix_audit_logs_resource_type", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_column("audit_logs", "ip_address")
    op.drop_column("audit_logs", "resource_id")
    op.drop_column("audit_logs", "resource_type")
    op.drop_column("audit_logs", "action")
