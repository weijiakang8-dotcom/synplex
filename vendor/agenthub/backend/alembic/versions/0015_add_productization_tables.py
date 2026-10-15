"""add productization tables: user api keys, skills, feedback, execution metadata

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_api_keys",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("api_key_encrypted", sa.Text(), nullable=False),
        sa.Column("api_key_hint", sa.String(8), nullable=False, server_default=""),
        sa.Column("base_url", sa.String(255), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_api_keys_user_id", "user_api_keys", ["user_id"])

    op.create_table(
        "skills",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("goal", sa.JSON(), nullable=False),
        sa.Column("plan_template", sa.JSON(), nullable=False),
        sa.Column("icon", sa.String(50), nullable=False, server_default="sparkles"),
        sa.Column(
            "organization_id",
            sa.Uuid(),
            sa.ForeignKey("organizations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_skills_organization_id", "skills", ["organization_id"])

    op.create_table(
        "execution_feedback",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "execution_id",
            sa.Uuid(),
            sa.ForeignKey("executions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "rating >= 1 AND rating <= 5", name="ck_execution_feedback_rating"
        ),
    )
    op.create_index(
        "ix_execution_feedback_execution_id", "execution_feedback", ["execution_id"]
    )

    op.add_column("executions", sa.Column("user_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_executions_user_id",
        "executions",
        "users",
        ["user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column("executions", sa.Column("steps", sa.JSON(), nullable=True))
    op.add_column("executions", sa.Column("token_usage", sa.JSON(), nullable=True))
    op.add_column("executions", sa.Column("model_used", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("executions", "model_used")
    op.drop_column("executions", "token_usage")
    op.drop_column("executions", "steps")
    op.drop_constraint("fk_executions_user_id", "executions", type_="foreignkey")
    op.drop_column("executions", "user_id")
    op.drop_index("ix_execution_feedback_execution_id", table_name="execution_feedback")
    op.drop_table("execution_feedback")
    op.drop_index("ix_skills_organization_id", table_name="skills")
    op.drop_table("skills")
    op.drop_index("ix_user_api_keys_user_id", table_name="user_api_keys")
    op.drop_table("user_api_keys")
