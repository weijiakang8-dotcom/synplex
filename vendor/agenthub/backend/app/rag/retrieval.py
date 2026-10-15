"""统一 RAG 检索入口：query → embedding → chunk vector search → context。"""

from __future__ import annotations

import uuid
from typing import Any

from app.engine.observability import trace_span
from app.rag.embedder import embed_text
from app.rag.vector_store import search_chunks


async def retrieve_chunks(
    query: str,
    organization_id: uuid.UUID | None,
    *,
    top_k: int = 5,
    correlation_id: str | None = None,
) -> list[dict[str, Any]]:
    async with trace_span(
        correlation_id,
        "rag",
        organization_id=str(organization_id) if organization_id else None,
        query=query,
        top_k=top_k,
    ):
        if not query:
            return []
        query_vec = await embed_text(query)
        return await search_chunks(
            query_vec, organization_id=organization_id, top_k=top_k
        )


async def retrieve_documents(
    query: str,
    organization_id: str | uuid.UUID | None,
    top_k: int = 3,
    correlation_id: str | None = None,
) -> list[dict[str, Any]]:
    """兼容旧调用：按 chunk 检索并去重到文档粒度。"""
    org = uuid.UUID(str(organization_id)) if organization_id is not None else None
    chunks = await retrieve_chunks(
        query,
        org,
        top_k=max(top_k, 3) * 2,
        correlation_id=correlation_id,
    )
    seen: set[str] = set()
    docs: list[dict[str, Any]] = []
    for chunk in chunks:
        doc_id = chunk.get("document_id") or chunk.get("name")
        if doc_id in seen:
            continue
        seen.add(doc_id)
        docs.append({"name": chunk["name"], "content": chunk["content"][:1000]})
        if len(docs) >= top_k:
            break
    return docs


__all__ = ["retrieve_chunks", "retrieve_documents"]
