import hashlib
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.artifacts.service import MIME_TYPES, artifact_path, public_artifact
from app.models.artifact import Artifact

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


@router.get("")
async def list_artifacts(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
):
    rows = (
        (
            await session.execute(
                select(Artifact).where(
                    Artifact.execution_id == execution_id,
                    Artifact.organization_id == user.organization_id,
                    Artifact.user_id == user.id,
                )
            )
        )
        .scalars()
        .all()
    )
    return [public_artifact(row) for row in rows]


@router.get("/{artifact_id}/download")
async def download_artifact(
    artifact_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
):
    row = await session.get(Artifact, artifact_id)
    if not row or row.organization_id != user.organization_id or row.user_id != user.id:
        raise HTTPException(404, "Artifact not found")
    path = artifact_path(row)
    if not path.is_file():
        raise HTTPException(410, "成果文件不可用，请检查持久存储或重新导出。")
    if hashlib.sha256(path.read_bytes()).hexdigest() != row.sha256:
        raise HTTPException(410, "成果文件校验失败，请重新导出。")
    return FileResponse(path, filename=row.filename, media_type=MIME_TYPES[row.format])
