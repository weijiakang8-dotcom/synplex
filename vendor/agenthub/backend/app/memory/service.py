"""统一 Memory 服务：Working / Conversation / Long-term / Knowledge / Execution / Cache。"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, select

from app.config import settings
from app.core.model_gateway import ModelGateway
from app.database import async_session_factory
from app.engine.observability import trace_span
from app.models import UserMemory, utcnow
from app.rag.embedder import embed_text

SIMILARITY_THRESHOLD = 0.9


def _cosine(a: list[float], b: list[float]) -> float:
    if len(a) == 0 or len(b) == 0:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


async def add_memory(
    *,
    user_id: uuid.UUID,
    organization_id: uuid.UUID | None,
    content: str,
    kind: str = "fact",
    importance: float = 0.5,
    source: str = "user",
    expires_at: datetime | None = None,
    merge: bool = True,
) -> UserMemory:
    if expires_at is None and settings.MEMORY_DEFAULT_TTL_DAYS > 0:
        expires_at = datetime.now(timezone.utc) + timedelta(
            days=settings.MEMORY_DEFAULT_TTL_DAYS
        )
    embedding = await embed_text(content)
    if merge:
        similar = await _find_similar_memory(
            user_id=user_id,
            organization_id=organization_id,
            embedding=embedding,
        )
        if similar is not None:
            async with async_session_factory() as session:
                existing = await session.get(UserMemory, similar.id)
                if existing is not None:
                    existing.content = content
                    existing.embedding = embedding
                    existing.importance = max(
                        float(existing.importance or 0.0),
                        max(0.0, min(1.0, importance)),
                    )
                    await session.commit()
                    await session.refresh(existing)
                    return existing
    async with async_session_factory() as session:
        memory = UserMemory(
            user_id=user_id,
            organization_id=organization_id,
            content=content,
            kind=kind,
            importance=max(0.0, min(1.0, importance)),
            source=source,
            expires_at=expires_at,
            embedding=embedding,
        )
        session.add(memory)
        await session.commit()
        await session.refresh(memory)
        return memory


async def _find_similar_memory(
    *,
    user_id: uuid.UUID,
    organization_id: uuid.UUID | None,
    embedding: list[float],
) -> UserMemory | None:
    """相似记忆合并/去重：相似度阈值 + importance 加权，不追加重复条目。"""
    now = datetime.now(timezone.utc)
    async with async_session_factory() as session:
        stmt = select(UserMemory).where(
            UserMemory.user_id == user_id,
            (UserMemory.expires_at.is_(None)) | (UserMemory.expires_at > now),
        )
        if organization_id is not None:
            stmt = stmt.where(UserMemory.organization_id == organization_id)
        candidates = list((await session.execute(stmt)).scalars().all())
    best: tuple[float, UserMemory | None] = (0.0, None)
    for candidate in candidates:
        if candidate.user_id != user_id:
            continue
        if organization_id is not None and candidate.organization_id != organization_id:
            continue
        candidate_embedding = candidate.embedding
        similarity = _cosine(
            embedding, candidate_embedding if candidate_embedding is not None else []
        )
        score = similarity + float(candidate.importance or 0.0) * 0.1
        if similarity >= SIMILARITY_THRESHOLD and score > best[0]:
            best = (score, candidate)
    return best[1]


async def update_memory(
    *,
    memory_id: uuid.UUID,
    user_id: uuid.UUID,
    content: str,
    importance: float | None = None,
    organization_id: uuid.UUID | None = None,
) -> UserMemory | None:
    """显式纠正/UPDATE：只更新用户自己的、属于指定租户的记忆。"""
    async with async_session_factory() as session:
        memory = await session.get(UserMemory, memory_id)
        if memory is None or memory.user_id != user_id:
            return None
        if organization_id is not None and memory.organization_id != organization_id:
            return None
        memory.content = content
        memory.embedding = await embed_text(content)
        if importance is not None:
            memory.importance = max(0.0, min(1.0, importance))
        await session.commit()
        await session.refresh(memory)
        return memory


async def list_memories(
    user_id: uuid.UUID,
    organization_id: uuid.UUID | None,
) -> list[UserMemory]:
    async with async_session_factory() as session:
        stmt = select(UserMemory).where(UserMemory.user_id == user_id)
        if organization_id is not None:
            stmt = stmt.where(UserMemory.organization_id == organization_id)
        result = await session.execute(stmt.order_by(UserMemory.updated_at.desc()))
        return list(result.scalars().all())


async def delete_memory(memory_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    async with async_session_factory() as session:
        result = await session.execute(
            delete(UserMemory).where(
                UserMemory.id == memory_id,
                UserMemory.user_id == user_id,
            )
        )
        await session.commit()
        return bool(result.rowcount)


async def retrieve_memories(
    *,
    user_id: uuid.UUID,
    organization_id: uuid.UUID | None,
    query: str,
    top_k: int = 3,
    correlation_id: str | None = None,
) -> list[dict[str, Any]]:
    """长期记忆检索（Observability span: memory）。"""
    async with trace_span(
        correlation_id,
        "memory",
        user_id=str(user_id),
        organization_id=str(organization_id) if organization_id else None,
        query=query,
    ):
        return await _retrieve_memories_impl(
            user_id=user_id,
            organization_id=organization_id,
            query=query,
            top_k=top_k,
        )


async def _retrieve_memories_impl(
    *,
    user_id: uuid.UUID,
    organization_id: uuid.UUID | None,
    query: str,
    top_k: int,
) -> list[dict[str, Any]]:
    """长期记忆检索：向量相似度 + importance 加权，tenant 隔离。"""
    now = datetime.now(timezone.utc)
    async with async_session_factory() as session:
        stmt = select(UserMemory).where(
            UserMemory.user_id == user_id,
            (UserMemory.expires_at.is_(None)) | (UserMemory.expires_at > now),
        )
        if organization_id is not None:
            stmt = stmt.where(UserMemory.organization_id == organization_id)
        memories = list((await session.execute(stmt)).scalars().all())

    if not memories:
        return []
    query_vec = await embed_text(query)
    scored = []
    for memory in memories:
        if memory.user_id != user_id:
            continue
        if organization_id is not None and memory.organization_id != organization_id:
            continue
        memory_embedding = memory.embedding
        similarity = _cosine(
            query_vec, memory_embedding if memory_embedding is not None else []
        )
        scored.append(
            (
                similarity + float(memory.importance or 0.0) * 0.1,
                memory,
            )
        )
    scored.sort(key=lambda item: item[0], reverse=True)

    picked = [memory for _, memory in scored[:top_k]]
    if picked:
        async with async_session_factory() as session:
            ids = [memory.id for memory in picked]
            rows = list(
                (
                    await session.execute(
                        select(UserMemory).where(UserMemory.id.in_(ids))
                    )
                )
                .scalars()
                .all()
            )
            for memory in rows:
                memory.last_accessed_at = utcnow()
            await session.commit()
    return [{"kind": m.kind, "content": m.content} for m in picked]


async def delete_expired_memories() -> int:
    """删除所有已过期记忆（expires_at < now）；返回删除条数。"""
    now = datetime.now(timezone.utc)
    async with async_session_factory() as session:
        result = await session.execute(
            delete(UserMemory).where(
                UserMemory.expires_at.is_not(None),
                UserMemory.expires_at < now,
            )
        )
        await session.commit()
        return int(result.rowcount or 0)


async def summarize_text(
    *,
    messages: list[dict[str, Any]],
    organization_id: str | None,
    user_id: str | None,
) -> str:
    from app.memory.conversation_context import compact_conversation

    gateway = ModelGateway()
    llms = await gateway.select(
        organization_id=organization_id, complexity="simple", user_id=user_id
    )
    _, summary, _ = await compact_conversation(
        messages,
        "",
        None,
        llms,
        organization_id=organization_id,
        force=True,
    )
    return summary or ""


__all__ = [
    "SIMILARITY_THRESHOLD",
    "add_memory",
    "delete_expired_memories",
    "delete_memory",
    "list_memories",
    "retrieve_memories",
    "summarize_text",
    "update_memory",
]
