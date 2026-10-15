"""create initial tables

Revision ID: 0001
Revises:
Create Date: 2026-08-13

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()

    agent_status = postgresql.ENUM("active", "inactive", name="agent_status")
    workflow_status = postgresql.ENUM(
        "draft", "active", "archived", name="workflow_status"
    )
    execution_status = postgresql.ENUM(
        "pending",
        "running",
        "waiting_for_approval",
        "completed",
        "failed",
        "rolled_back",
        name="execution_status",
    )
    tool_call_status = postgresql.ENUM(
        "pending",
        "success",
        "failed",
        "approved",
        "rejected",
        name="tool_call_status",
    )

    for enum_type in (
        agent_status,
        workflow_status,
        execution_status,
        tool_call_status,
    ):
        enum_type.create(bind, checkfirst=True)

    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("tools", sa.JSON(), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(
                "active", "inactive", name="agent_status", create_type=False
            ),
            nullable=False,
        ),
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
        sa.UniqueConstraint("name", name="uq_agents_name"),
    )

    op.create_table(
        "workflows",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("agent_chain", sa.JSON(), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(
                "draft", "active", "archived", name="workflow_status", create_type=False
            ),
            nullable=False,
        ),
        sa.Column("created_by", sa.String(255), nullable=False),
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
    op.create_index("ix_workflows_name", "workflows", ["name"])

    op.create_table(
        "executions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("workflow_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(
                "pending",
                "running",
                "waiting_for_approval",
                "completed",
                "failed",
                "rolled_back",
                name="execution_status",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("current_step_index", sa.Integer(), nullable=False),
        sa.Column("checkpoint_data", sa.JSON(), nullable=True),
        sa.Column("user_input", sa.Text(), nullable=False),
        sa.Column("final_output", sa.Text(), nullable=True),
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
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["workflow_id"], ["workflows.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_executions_workflow_id", "executions", ["workflow_id"])

    op.create_table(
        "tool_calls",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tool_name", sa.String(255), nullable=False),
        sa.Column("input_params", sa.JSON(), nullable=False),
        sa.Column("output_result", sa.JSON(), nullable=True),
        sa.Column(
            "status",
            postgresql.ENUM(
                "pending",
                "success",
                "failed",
                "approved",
                "rejected",
                name="tool_call_status",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("requires_approval", sa.Boolean(), nullable=False),
        sa.Column("approved_by", sa.String(255), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["execution_id"], ["executions.id"], ondelete="CASCADE"
        ),
    )
    op.create_index("ix_tool_calls_execution_id", "tool_calls", ["execution_id"])


def downgrade() -> None:
    bind = op.get_bind()

    op.drop_index("ix_tool_calls_execution_id", table_name="tool_calls")
    op.drop_table("tool_calls")
    op.drop_index("ix_executions_workflow_id", table_name="executions")
    op.drop_table("executions")
    op.drop_index("ix_workflows_name", table_name="workflows")
    op.drop_table("workflows")
    op.drop_table("agents")

    for name in (
        "tool_call_status",
        "execution_status",
        "workflow_status",
        "agent_status",
    ):
        postgresql.ENUM(name=name).drop(bind, checkfirst=True)
