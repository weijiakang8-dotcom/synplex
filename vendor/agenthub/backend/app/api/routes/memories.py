import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import CurrentUserDep, SessionDep
from app.memory import service as memory_service

router = APIRouter(prefix="/memories", tags=["memories"])


class MemoryCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)
    kind: str = "fact"
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    expires_at: datetime | None = None


def _serialize(memory) -> dict:
    return {
        "id": str(memory.id),
        "kind": memory.kind,
        "content": memory.content,
        "importance": memory.importance,
        "source": memory.source,
        "created_at": memory.created_at.isoformat(),
        "updated_at": memory.updated_at.isoformat(),
        "expires_at": memory.expires_at.isoformat() if memory.expires_at else None,
    }


@router.get("")
async def list_memories(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    return [
        _serialize(memory)
        for memory in await memory_service.list_memories(user.id, user.organization_id)
    ]


@router.post("", status_code=201)
async def create_memory(
    payload: MemoryCreate, session: SessionDep, user: CurrentUserDep
) -> dict:
    memory = await memory_service.add_memory(
        user_id=user.id,
        organization_id=user.organization_id,
        content=payload.content,
        kind=payload.kind,
        importance=payload.importance,
        expires_at=payload.expires_at,
    )
    return _serialize(memory)


@router.delete("/{memory_id}", status_code=204)
async def delete_memory(
    memory_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    deleted = await memory_service.delete_memory(memory_id, user.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")
