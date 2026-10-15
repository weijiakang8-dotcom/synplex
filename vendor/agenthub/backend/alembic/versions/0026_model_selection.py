"""conversation and execution level model selection

支持在对话里随时选用具体模型与思考等级：选择同时记在会话（供下次打开沿用）
和执行（真正跑起来时按它选模型，不受自动路由改写）。

Revision ID: 0026_model_selection
Revises: 0025_artifacts
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0026_model_selection"
down_revision = "0025_artifacts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("model_selection", sa.JSON(), nullable=True),
    )
    op.add_column(
        "executions",
        sa.Column("model_selection", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("executions", "model_selection")
    op.drop_column("conversations", "model_selection")
