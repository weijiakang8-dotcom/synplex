"""Vector Store 抽象：PostgreSQL + pgvector 为最终方向。"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import delete, select, text

from app.database import async_session_factory
from app.models import Document, DocumentChunk
from app.rag.chunking import split_text
from app.rag.embedder import embed_text

logger = logging.getLogger(__name__)

MIN_SIMILARITY = 0.3


async def rebuild_document_chunks(document: Document) -> int:
    """删除旧分块并按新策略重建，返回分块数。"""
    chunks = split_text(document.content)
    embeddings = [await embed_text(chunk) for chunk in chunks]
    async with async_session_factory() as session:
        await session.execute(
            delete(DocumentChunk).where(DocumentChunk.document_id == document.id)
        )
        for index, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            session.add(
                DocumentChunk(
                    document_id=document.id,
                    organization_id=document.organization_id,
                    chunk_index=index,
                    content=chunk,
                    metadata_json={
                        "document_id": str(document.id),
                        "name": document.name,
                    },
                    embedding=embedding,
                )
            )
        await session.commit()
    return len(chunks)


async def delete_document_chunks(document_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        await session.execute(
            delete(DocumentChunk).where(DocumentChunk.document_id == document_id)
        )
        await session.commit()


async def search_chunks(
    query_vector: list[float],
    *,
    organization_id: uuid.UUID | None,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """pgvector 余弦检索；任何故障 fail-open 为空列表。"""
    if not query_vector:
        return []
    try:
        async with async_session_factory() as session:
            stmt = (
                select(
                    DocumentChunk,
                    Document.name,
                    DocumentChunk.embedding.cosine_distance(query_vector).label(
                        "distance"
                    ),
                )
                .join(Document, Document.id == DocumentChunk.document_id)
                .where(DocumentChunk.embedding.is_not(None))
                .order_by(DocumentChunk.embedding.cosine_distance(query_vector))
            )
            if organization_id is not None:
                stmt = stmt.where(DocumentChunk.organization_id == organization_id)
            result = await session.execute(stmt)
            items = []
            for chunk, name, distance in result.all():
                score = max(0.0, 1.0 - float(distance))
                if score < MIN_SIMILARITY:
                    continue
                items.append(
                    {
                        "name": name,
                        "content": chunk.content,
                        "score": score,
                        "document_id": str(chunk.document_id),
                    }
                )
                if len(items) >= top_k:
                    break
            return items
    except Exception:  # noqa: BLE001
        return []


def _ensure_vector_extension_sql() -> str:
    return "CREATE EXTENSION IF NOT EXISTS vector"


async def ensure_schema() -> None:
    try:
        async with async_session_factory() as session:
            await session.execute(text(_ensure_vector_extension_sql()))
            await session.commit()
    except Exception:
        logger.warning("pgvector schema ensure failed", exc_info=True)


__all__ = [
    "delete_document_chunks",
    "ensure_schema",
    "rebuild_document_chunks",
    "search_chunks",
]
