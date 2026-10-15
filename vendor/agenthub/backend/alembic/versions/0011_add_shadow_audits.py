"""add shadow_audits

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-17

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "shadow_audits",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("execution_id", sa.Uuid(), nullable=False),
        sa.Column("workflow_id", sa.Uuid(), nullable=True),
        sa.Column("shadow_status", sa.String(length=40), nullable=False),
        sa.Column("kernel_termination", sa.String(length=80), nullable=True),
        sa.Column("kernel_goal_status", sa.String(length=40), nullable=True),
        sa.Column("evidence_level", sa.String(length=40), nullable=True),
        sa.Column("semantic_match", sa.Boolean(), nullable=True),
        sa.Column("information_loss", sa.JSON(), nullable=False),
        sa.Column("violations", sa.JSON(), nullable=False),
        sa.Column("trace", sa.JSON(), nullable=False),
        sa.Column("error_type", sa.String(length=120), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_shadow_audits_execution_id", "shadow_audits", ["execution_id"])
    op.create_index("ix_shadow_audits_workflow_id", "shadow_audits", ["workflow_id"])


def downgrade() -> None:
    op.drop_index("ix_shadow_audits_workflow_id", table_name="shadow_audits")
    op.drop_index("ix_shadow_audits_execution_id", table_name="shadow_audits")
    op.drop_table("shadow_audits")
