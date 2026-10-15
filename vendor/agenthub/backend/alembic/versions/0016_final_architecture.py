"""final architecture freeze: intent/plan, conversation summary, user memory,
document chunks + pgvector, tool idempotency.

Revision ID: 0016
Revises: 0015
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMBEDDING_DIMENSION = 768
CHUNK_SIZE = 800
CHUNK_OVERLAP = 100


def _split_chunks(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - CHUNK_OVERLAP
    return chunks


def _hash_embed(text: str, dims: int) -> list[float]:
    vec = [0.0] * dims
    tokens = re.findall(r"[a-zA-Z0-9\u4e00-\u9fff]+", text.lower())
    for i in range(len(tokens)):
        for n in (1, 2, 3):
            gram = " ".join(tokens[i : i + n])
            idx = (
                int.from_bytes(hashlib.md5(gram.encode()).digest()[:4], "little") % dims
            )
            vec[idx] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.add_column("executions", sa.Column("intent", sa.JSON(), nullable=True))
    op.add_column("executions", sa.Column("plan", sa.JSON(), nullable=True))
    op.add_column("conversations", sa.Column("summary", sa.Text(), nullable=True))
    op.add_column(
        "tool_calls", sa.Column("idempotency_key", sa.String(64), nullable=True)
    )
    op.create_index("ix_tool_calls_idempotency_key", "tool_calls", ["idempotency_key"])

    op.create_table(
        "user_memories",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column(
            "organization_id",
            sa.Uuid(),
            sa.ForeignKey("organizations.id", ondelete="SET NULL"),
            index=True,
            nullable=True,
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIMENSION), nullable=True),
        sa.Column("importance", sa.Float(), nullable=False),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
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

    op.create_table(
        "document_chunks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column(
            "organization_id",
            sa.Uuid(),
            sa.ForeignKey("organizations.id", ondelete="SET NULL"),
            index=True,
            nullable=True,
        ),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIMENSION), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, organization_id, content, metadata FROM documents")
    ).fetchall()
    for row in rows:
        for index, chunk in enumerate(_split_chunks(row.content or "")):
            vector = _hash_embed(chunk, EMBEDDING_DIMENSION)
            bind.execute(
                sa.text(
                    "INSERT INTO document_chunks "
                    "(id, document_id, organization_id, chunk_index, content, metadata, embedding) "
                    "VALUES (gen_random_uuid(), :doc, :org, :idx, :content, "
                    "CAST(:meta AS json), CAST(:embedding AS vector))"
                ),
                {
                    "doc": row.id,
                    "org": row.organization_id,
                    "idx": index,
                    "content": chunk,
                    "meta": json.dumps({}),
                    "embedding": "[" + ",".join(str(x) for x in vector) + "]",
                },
            )


def downgrade() -> None:
    op.drop_table("document_chunks")
    op.drop_table("user_memories")
    op.drop_index("ix_tool_calls_idempotency_key", table_name="tool_calls")
    op.drop_column("tool_calls", "idempotency_key")
    op.drop_column("conversations", "summary")
    op.drop_column("executions", "plan")
    op.drop_column("executions", "intent")
