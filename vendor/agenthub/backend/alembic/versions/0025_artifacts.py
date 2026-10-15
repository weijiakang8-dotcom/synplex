"""Durable tenant/user-owned artifacts."""

import sqlalchemy as sa

from alembic import op

revision = "0025_artifacts"
down_revision = "0024_execution_events"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "artifacts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "execution_id",
            sa.Uuid(),
            sa.ForeignKey("executions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "organization_id",
            sa.Uuid(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("format", sa.String(20), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "execution_id", "sha256", "format", name="uq_artifact_content"
        ),
    )
    for col in ("execution_id", "organization_id", "user_id"):
        op.create_index(f"ix_artifacts_{col}", "artifacts", [col])


def downgrade():
    op.drop_table("artifacts")
