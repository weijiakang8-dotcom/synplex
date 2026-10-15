"""Phase 6A：tool_call IN_FLIGHT 状态 + 幂等键唯一索引。

Revision ID: 0017
Revises: 0016
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TYPE tool_call_status ADD VALUE IF NOT EXISTS 'in_flight'")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_calls_exec_idempotency "
        "ON tool_calls (execution_id, idempotency_key) "
        "WHERE idempotency_key IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_tool_calls_exec_idempotency")
    # PostgreSQL 不支持移除 enum 值；in_flight 保留，不回滚历史数据。
