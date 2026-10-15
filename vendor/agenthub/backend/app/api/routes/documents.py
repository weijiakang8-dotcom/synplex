from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core.permissions import require_permission
from app.models import Document
from app.rag.embedder import cosine, embed_text
from app.rag.vector_store import delete_document_chunks, rebuild_document_chunks

router = APIRouter(prefix="/documents", tags=["documents"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024
MAX_PDF_PAGES = 200
TEXT_CONTENT_TYPES = {"", "text/plain", "text/markdown"}
PDF_CONTENT_TYPES = {"", "application/pdf"}


async def _read_upload_limited(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(UPLOAD_CHUNK_BYTES):
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413, detail="File exceeds upload size limit"
            )
        chunks.append(chunk)
    return b"".join(chunks)


class DocumentUpload(BaseModel):
    name: str
    content: str
    metadata: dict = {}


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5


def _serialize(d: Document) -> dict:
    return {
        "id": str(d.id),
        "name": d.name,
        "content": d.content,
        "metadata": d.metadata_json,
        "created_at": d.created_at.isoformat(),
    }


@router.get("")
async def list_documents(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(Document).order_by(Document.created_at.desc()).limit(200)
    if user.organization_id is not None:
        stmt = stmt.where(Document.organization_id == user.organization_id)
    result = await session.execute(stmt)
    return [_serialize(d) for d in result.scalars().all()]


@router.post(
    "/upload",
    status_code=201,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def upload_document(
    session: SessionDep,
    user: CurrentUserDep,
    file: UploadFile = File(...),  # noqa: B008
) -> dict:
    raw = await _read_upload_limited(file)
    filename = file.filename or "document.txt"
    lower = filename.lower()
    content_type = (file.content_type or "").lower().split(";", 1)[0].strip()

    if lower.endswith((".txt", ".md", ".markdown")):
        if content_type not in TEXT_CONTENT_TYPES or raw.startswith(b"%PDF-"):
            raise HTTPException(
                status_code=422, detail="File content type does not match extension"
            )
        content = raw.decode("utf-8", errors="strict")
    elif lower.endswith(".pdf"):
        if content_type not in PDF_CONTENT_TYPES or not raw.startswith(b"%PDF-"):
            raise HTTPException(
                status_code=422, detail="File content does not match PDF type"
            )
        try:
            from io import BytesIO

            from pypdf import PdfReader

            reader = PdfReader(BytesIO(raw))
            if len(reader.pages) > MAX_PDF_PAGES:
                raise HTTPException(status_code=413, detail="PDF exceeds page limit")
            content = "\n".join((page.extract_text() or "") for page in reader.pages)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"PDF parsing failed: {exc}")
    else:
        raise HTTPException(status_code=422, detail="Unsupported file type")

    if not content.strip():
        raise HTTPException(status_code=422, detail="Document content is empty")

    embedding = await embed_text(content[:4000])
    document = Document(
        organization_id=user.organization_id,
        user_id=user.id,
        name=filename,
        content=content,
        metadata_json={"filename": filename, "content_type": file.content_type or ""},
        embedding=embedding,
    )
    session.add(document)
    await session.commit()
    await session.refresh(document)
    await rebuild_document_chunks(document)
    return _serialize(document)


@router.post(
    "",
    status_code=201,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def create_document(
    payload: DocumentUpload, session: SessionDep, user: CurrentUserDep
) -> dict:
    embedding = await embed_text(payload.content[:4000])
    document = Document(
        organization_id=user.organization_id,
        user_id=user.id,
        name=payload.name,
        content=payload.content,
        metadata_json=payload.metadata,
        embedding=embedding,
    )
    session.add(document)
    await session.commit()
    await session.refresh(document)
    await rebuild_document_chunks(document)
    return _serialize(document)


@router.delete(
    "/{document_id}",
    status_code=204,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def delete_document(
    document_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    document = await session.get(Document, document_id)
    if document is None or (
        user.organization_id is not None
        and document.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Document not found")
    await delete_document_chunks(document.id)
    await session.delete(document)
    await session.commit()


@router.post("/search")
async def search_documents(
    payload: SearchRequest, session: SessionDep, user: CurrentUserDep
) -> list[dict]:
    query_vec = await embed_text(payload.query)
    stmt = select(Document)
    if user.organization_id is not None:
        stmt = stmt.where(Document.organization_id == user.organization_id)
    documents = (await session.execute(stmt)).scalars().all()

    scored = []
    keywords = payload.query.lower().split()
    for doc in documents:
        vector_score = cosine(query_vec, doc.embedding or [])
        keyword_score = sum(1 for k in keywords if k in doc.content.lower())
        score = vector_score + keyword_score * 0.2
        scored.append((score, doc))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [_serialize(doc) for _, doc in scored[: payload.top_k]]
