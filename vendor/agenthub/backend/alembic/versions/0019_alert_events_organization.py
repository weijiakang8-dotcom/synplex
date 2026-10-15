"""Phase 6B：alert_events 补充 organization_id（模型与 DB 对齐，幂等）。

Revision ID: 0019
Revises: 0018

C-2 修复：0008_full_schema_backfill 在全新库上已经创建
alert_events.organization_id（含索引与外键）；本迁移改为条件式执行，
列/索引/外键存在即跳过，保证 0001→0019 可在全新库一次性成功，
同时不改变已应用 0019 的数据库（upgrade head 为 no-op）。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = {col["name"] for col in inspector.get_columns("alert_events")}
    if "organization_id" not in columns:
        op.add_column(
            "alert_events",
            sa.Column(
                "organization_id",
                sa.Uuid(),
                nullable=True,
            ),
        )

    indexes = {idx["name"] for idx in inspector.get_indexes("alert_events")}
    if "ix_alert_events_organization_id" not in indexes:
        op.create_index(
            "ix_alert_events_organization_id",
            "alert_events",
            ["organization_id"],
        )

    foreign_keys = {fk["name"] for fk in inspector.get_foreign_keys("alert_events")}
    if "fk_alert_events_organization_id" not in foreign_keys:
        op.create_foreign_key(
            "fk_alert_events_organization_id",
            "alert_events",
            "organizations",
            ["organization_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    op.drop_column("alert_events", "organization_id")
