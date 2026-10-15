"""Authenticated integration with one configured executor per tenant.

Existing execution graph is preserved; sidecar work is a separate durable domain.
No arbitrary proxy paths, client-supplied endpoints, or shared runner credentials.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUserDep, SessionDep
from app.config import settings
from app.models import SynplexTask

router = APIRouter(prefix="/synplex", tags=["synplex"])


class Material(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=500000)


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    request_id: str = Field(alias="requestId", pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    prompt: str = Field(min_length=1, max_length=25000)
    title: str | None = Field(default=None, max_length=70)
    acceptance: str = Field(default="", max_length=8000)
    expected_files: list[str] = Field(
        default_factory=list, alias="expectedFiles", max_length=30
    )
    files: list[Material] = Field(default_factory=list, max_length=30)
    time_limit_seconds: int = Field(
        default=900, alias="timeLimitSeconds", ge=30, le=3600
    )
    money_budget: float | None = Field(default=None, alias="moneyBudget", gt=0, le=1000)
    checks: list[dict] = Field(default_factory=list, max_length=50)


def connection(user, connection_id: str | None = None) -> dict:
    if user.organization_id is None:
        raise HTTPException(403, "请先加入组织再使用任务工作台")
    try:
        registry = json.loads(Path(settings.SYNPLEX_CONNECTIONS_FILE).read_text())
        value = registry[str(user.organization_id)]
        parsed = urlsplit(value["url"])
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("invalid sidecar")
        if connection_id is not None and value["id"] != connection_id:
            raise HTTPException(
                409, "执行连接已更换，请管理员迁移原任务后继续；未重复执行"
            )
        if any(
            str(other) != str(user.organization_id)
            and entry.get("url", "").rstrip("/") == value["url"].rstrip("/")
            for other, entry in registry.items()
        ):
            raise HTTPException(
                503, "多个组织不能共享同一执行连接，请配置各自独立的执行服务"
            )
        return value
    except HTTPException:
        raise
    except (OSError, KeyError, ValueError, TypeError) as exc:
        raise HTTPException(
            503, "本组织尚未连接执行服务，请管理员配置独立连接；已有功能仍可使用"
        ) from exc


async def relay(config: dict, route: str, body: dict | None = None, *, binary=False):
    try:
        token = Path(config["tokenFile"]).read_text().strip()
        async with httpx.AsyncClient(
            timeout=20, follow_redirects=False, trust_env=False
        ) as client:
            response = await client.request(
                "POST" if body is not None else "GET",
                config["url"].rstrip("/") + route,
                headers={"Authorization": f"Bearer {token}"},
                **({"json": body} if body is not None else {}),
            )
    except (OSError, httpx.HTTPError, KeyError) as exc:
        raise HTTPException(
            503,
            "执行服务暂不可用，任务与材料已保存。恢复连接后用原请求继续，无需重复创建",
        ) from exc
    if not response.is_success:
        try:
            message = response.json().get("error") or "执行服务未完成此操作"
        except ValueError:
            message = "执行服务响应异常，先查看实际任务状态再续接"
        raise HTTPException(
            409 if response.status_code < 500 else 503, str(message)[:1000]
        )
    if binary:
        if len(response.content) > 20 * 1024 * 1024:
            raise HTTPException(
                413, "成果超过20MB，文件保留在执行服务，请管理员协助取回"
            )
        return response.content
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(502, "执行服务返回格式异常，未重复操作") from exc


def task_view(row: SynplexTask) -> dict:
    value = dict(row.snapshot or {})
    value["id"] = str(row.id)
    value.pop("operations", None)
    value.pop("requestKey", None)
    return value


async def owned(task_id: uuid.UUID, user, session) -> SynplexTask:
    row = await session.get(SynplexTask, task_id)
    if (
        row is None
        or row.organization_id != user.organization_id
        or row.user_id != user.id
    ):
        raise HTTPException(404, "任务不存在")
    return row


async def refresh(row, user, session):
    if not row.external_id:
        return task_view(row)
    row.snapshot = await relay(
        connection(user, row.connection_id), f"/api/workflows/{row.external_id}"
    )
    await session.commit()
    return task_view(row)


@router.get("/config")
async def get_config(user: CurrentUserDep):
    config = connection(user)
    catalog = await relay(config, "/api/catalog")
    info = await relay(config, "/api/config")
    return {"catalog": catalog, "executor": info["executor"], "maxFileBytes": 1500000}


@router.post("/pricing")
async def set_pricing(body: dict, user: CurrentUserDep):
    if user.role != "admin":
        raise HTTPException(403, "仅组织管理员可设置服务商价格")
    return await relay(connection(user), "/api/pricing", body)


@router.get("/evaluation")
async def evaluation(user: CurrentUserDep):
    return await relay(connection(user), "/api/evaluation")


@router.get("/extensions/{host}")
async def extension(host: str, user: CurrentUserDep):
    names = {
        "codex": "synplex-codex-marketplace.tgz",
        "dsh": "synplex-dsh-extension-0.3.0.tgz",
    }
    if host not in names:
        raise HTTPException(404, "扩展不存在")
    target = Path(settings.SYNPLEX_EXTENSION_ROOT) / names[host]
    if not settings.SYNPLEX_EXTENSION_ROOT or not target.is_file():
        raise HTTPException(503, "扩展安装包尚未配置，请管理员运行打包脚本")
    return FileResponse(target, filename=names[host], media_type="application/gzip")


@router.get("/tasks")
async def list_tasks(user: CurrentUserDep, session: SessionDep):
    rows = (
        (
            await session.execute(
                select(SynplexTask)
                .where(
                    SynplexTask.organization_id == user.organization_id,
                    SynplexTask.user_id == user.id,
                )
                .order_by(SynplexTask.created_at.desc())
                .limit(100)
            )
        )
        .scalars()
        .all()
    )
    return [task_view(row) for row in rows]


@router.post("/tasks", status_code=201)
async def create_task(payload: TaskRequest, user: CurrentUserDep, session: SessionDep):
    # Rollback expires ORM dependency objects. Freeze authenticated identity before writes.
    user = SimpleNamespace(
        id=user.id, organization_id=user.organization_id, role=user.role
    )
    config = connection(user)
    body = payload.model_dump(by_alias=True, exclude_none=True)
    if sum(len(f.content) for f in payload.files) > 1500000:
        raise HTTPException(413, "材料超过150万字符，请分批提交")
    task_id = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"synplex:{user.organization_id}:{user.id}:{payload.request_id}",
    )
    digest = hashlib.sha256(
        json.dumps(body, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    row = await session.get(SynplexTask, task_id)
    if row is None:
        row = SynplexTask(
            id=task_id,
            organization_id=user.organization_id,
            user_id=user.id,
            connection_id=config["id"],
            request_fingerprint=digest,
            snapshot={
                "title": payload.title or payload.prompt[:70],
                "status": "connecting",
                "contract": body,
            },
        )
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            row = await session.get(SynplexTask, task_id)
    if row.request_fingerprint != digest:
        raise HTTPException(409, "同一请求标识不能用于不同需求")
    if row.external_id:
        return await refresh(row, user, session)
    body["requestId"] = task_id.hex
    # External create is idempotent even if the backend dies before binding commit.
    value = await relay(connection(user, row.connection_id), "/api/workflows", body)
    row.external_id = value["id"]
    row.snapshot = value
    await session.commit()
    return task_view(row)


@router.get("/tasks/{task_id}")
async def get_task(task_id: uuid.UUID, user: CurrentUserDep, session: SessionDep):
    return await refresh(await owned(task_id, user, session), user, session)


@router.post("/tasks/{task_id}/{action}")
async def act(
    task_id: uuid.UUID,
    action: str,
    body: dict,
    user: CurrentUserDep,
    session: SessionDep,
):
    user = SimpleNamespace(
        id=user.id, organization_id=user.organization_id, role=user.role
    )
    allowed = {
        "select",
        "answer",
        "select-partial",
        "cancel",
        "resume",
        "revise",
        "review",
        "refresh-routes",
        "retry-tool",
        "compare",
        "continue-connection",
    }
    if action not in allowed:
        raise HTTPException(404, "操作不存在")
    row = await owned(task_id, user, session)
    if action == "continue-connection":
        if row.external_id:
            return await refresh(row, user, session)
        payload = TaskRequest.model_validate((row.snapshot or {})["contract"])
        return await create_task(payload, user, session)
    if not row.external_id:
        raise HTTPException(409, "连接尚未完成，请恢复原连接；无需新建任务")
    if action in {"resume", "revise", "compare"} and not body.get("requestId"):
        raise HTTPException(422, "恢复、修改与对照需要稳定的请求标识")
    if len(json.dumps(body)) > 20000:
        raise HTTPException(413, "操作说明过长")
    body = dict(body)
    if body.get("requestId"):
        body["requestId"] = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"synplex-op:{task_id}:{user.id}:{action}:{body['requestId']}",
        ).hex
    value = await relay(
        connection(user, row.connection_id),
        f"/api/workflows/{row.external_id}/{action}",
        body,
    )
    if action == "compare":
        # A comparison is another separately owned task, not a replacement binding.
        comparison_id = uuid.uuid5(
            uuid.NAMESPACE_URL, f"synplex-compare:{task_id}:{body['requestId']}"
        )
        compared = SynplexTask(
            id=comparison_id,
            organization_id=user.organization_id,
            user_id=user.id,
            connection_id=row.connection_id,
            external_id=value["id"],
            request_fingerprint=hashlib.sha256(
                json.dumps(body, sort_keys=True).encode()
            ).hexdigest(),
            snapshot=value,
        )
        existing = (
            await session.execute(
                select(SynplexTask).where(
                    SynplexTask.organization_id == user.organization_id,
                    SynplexTask.user_id == user.id,
                    SynplexTask.external_id == value["id"],
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return task_view(existing)
        session.add(compared)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            compared = await owned(comparison_id, user, session)
        return task_view(compared)
    row.snapshot = value
    await session.commit()
    return task_view(row)


@router.get("/tasks/{task_id}/inputs")
async def inputs(task_id: uuid.UUID, user: CurrentUserDep, session: SessionDep):
    row = await owned(task_id, user, session)
    if not row.external_id:
        return (row.snapshot or {}).get("contract", {}).get("files", [])
    return await relay(
        connection(user, row.connection_id), f"/api/workflows/{row.external_id}/inputs"
    )


@router.get("/tasks/{task_id}/bundle")
async def download_bundle(
    task_id: uuid.UUID, user: CurrentUserDep, session: SessionDep
):
    row = await owned(task_id, user, session)
    if not row.external_id:
        raise HTTPException(409, "尚无成果")
    content = await relay(
        connection(user, row.connection_id),
        f"/api/workflows/{row.external_id}/bundle",
        binary=True,
    )
    return Response(
        content,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="synplex-delivery.zip"'},
    )


@router.get("/tasks/{task_id}/file")
async def download_file(
    task_id: uuid.UUID, path: str, user: CurrentUserDep, session: SessionDep
):
    from urllib.parse import quote

    row = await owned(task_id, user, session)
    value = await refresh(row, user, session)
    file = next((f for f in value.get("files", []) if f["path"] == path), None)
    if file is None:
        raise HTTPException(404, "成果不存在")
    content = await relay(
        connection(user, row.connection_id),
        f"/api/workflows/{row.external_id}/file?path={quote(path, safe='')}",
        binary=True,
    )
    if hashlib.sha256(content).hexdigest() != file["sha256"]:
        raise HTTPException(409, "成果已变化，请刷新后再下载")
    return Response(
        content,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(Path(path).name, safe='')}"
        },
    )
