"""Bind external Synplex tasks to authenticated users and tenants.

Revision ID: 0027_synplex_tasks
Revises: 0026_model_selection
"""

import sqlalchemy as sa

from alembic import op

revision = "0027_synplex_tasks"
down_revision = "0026_model_selection"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "synplex_tasks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "organization_id",
            sa.Uuid(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("connection_id", sa.String(100), nullable=False),
        sa.Column("external_id", sa.String(100), nullable=True),
        sa.Column("request_fingerprint", sa.String(64), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_synplex_tasks_organization_id", "synplex_tasks", ["organization_id"]
    )
    op.create_index("ix_synplex_tasks_user_id", "synplex_tasks", ["user_id"])


def downgrade():
    op.drop_table("synplex_tasks")
