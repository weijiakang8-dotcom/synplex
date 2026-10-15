import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from app.api.deps import CurrentUserDep, SessionDep, get_current_user
from app.core.permissions import require_permission
from app.models import Agent, Execution, Workflow, WorkflowVersion
from app.models.enums import ExecutionStatus
from app.schemas.agent import AgentRead
from app.schemas.workflow import (
    WorkflowCreate,
    WorkflowDetail,
    WorkflowRead,
    WorkflowUpdate,
)

router = APIRouter(prefix="/workflows", tags=["workflows"])


def _extract_agent_ids(agent_chain) -> list[uuid.UUID]:
    """从 agent_chain（可能是 ID 列表或带 agent_id/id 节点的 DAG 结构）中提取 Agent ID。"""
    ids: list[uuid.UUID] = []

    def visit(value) -> None:
        if isinstance(value, str):
            try:
                ids.append(uuid.UUID(value))
            except ValueError:
                pass
        elif isinstance(value, dict):
            for key in ("agent_id", "id"):
                if key in value:
                    visit(value[key])
            if "nodes" in value:
                visit(value["nodes"])
        elif isinstance(value, (list, tuple)):
            for item in value:
                visit(item)

    visit(agent_chain)
    return ids


async def _snapshot_version(
    session, workflow: Workflow, changelog: str = ""
) -> WorkflowVersion:
    latest = await session.execute(
        select(func.max(WorkflowVersion.version)).where(
            WorkflowVersion.workflow_id == workflow.id
        )
    )
    next_version = (latest.scalar() or 0) + 1
    version = WorkflowVersion(
        workflow_id=workflow.id,
        version=next_version,
        config_snapshot={
            "name": workflow.name,
            "description": workflow.description,
            "agent_chain": workflow.agent_chain,
        },
        changelog=changelog,
        created_by=workflow.created_by,
    )
    session.add(version)
    return version


async def _get_workflow_for_user(
    session, workflow_id: uuid.UUID, user: CurrentUserDep
) -> Workflow:
    workflow = await session.get(Workflow, workflow_id)
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if (
        user.organization_id is not None
        and workflow.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


@router.get("", response_model=list[WorkflowRead])
async def list_workflows(
    session: SessionDep,
    user: CurrentUserDep,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[Workflow]:
    stmt = select(Workflow)
    if user.organization_id is not None:
        stmt = stmt.where(Workflow.organization_id == user.organization_id)
    stmt = stmt.order_by(Workflow.created_at.desc()).offset(skip).limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


@router.get("/{workflow_id}", response_model=WorkflowDetail)
async def get_workflow(
    workflow_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> WorkflowDetail:
    workflow = await _get_workflow_for_user(session, workflow_id, user)

    detail = WorkflowDetail.model_validate(workflow)
    agent_ids = _extract_agent_ids(workflow.agent_chain)
    if agent_ids:
        result = await session.execute(select(Agent).where(Agent.id.in_(agent_ids)))
        detail.agents = [AgentRead.model_validate(a) for a in result.scalars().all()]
    return detail


@router.post(
    "",
    response_model=WorkflowRead,
    status_code=201,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("resources:write")),
    ],
)
async def create_workflow(
    payload: WorkflowCreate, session: SessionDep, user: CurrentUserDep
) -> Workflow:
    workflow = Workflow(**payload.model_dump(), organization_id=user.organization_id)
    session.add(workflow)
    await session.commit()
    return workflow


@router.put(
    "/{workflow_id}",
    response_model=WorkflowRead,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("resources:write")),
    ],
)
async def update_workflow(
    workflow_id: uuid.UUID,
    payload: WorkflowUpdate,
    session: SessionDep,
    user: CurrentUserDep,
) -> Workflow:
    workflow = await _get_workflow_for_user(session, workflow_id, user)

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(workflow, key, value)

    await _snapshot_version(
        session,
        workflow,
        changelog=payload.changelog if hasattr(payload, "changelog") else "",
    )
    await session.commit()
    return workflow


@router.get("/{workflow_id}/versions")
async def list_workflow_versions(
    workflow_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> list[dict]:
    await _get_workflow_for_user(session, workflow_id, user)
    result = await session.execute(
        select(WorkflowVersion)
        .where(WorkflowVersion.workflow_id == workflow_id)
        .order_by(WorkflowVersion.version.desc())
    )
    versions = result.scalars().all()
    return [
        {
            "id": str(v.id),
            "version": v.version,
            "changelog": v.changelog,
            "created_by": v.created_by,
            "created_at": v.created_at.isoformat(),
            "config_snapshot": v.config_snapshot,
        }
        for v in versions
    ]


@router.post(
    "/{workflow_id}/versions",
    dependencies=[Depends(require_permission("resources:write"))],
)
async def create_workflow_version(
    workflow_id: uuid.UUID,
    session: SessionDep,
    user: CurrentUserDep,
    changelog: str = "",
) -> dict:
    workflow = await _get_workflow_for_user(session, workflow_id, user)
    version = await _snapshot_version(session, workflow, changelog)
    await session.commit()
    return {"version": version.version, "id": str(version.id)}


@router.post(
    "/{workflow_id}/rollback",
    response_model=WorkflowRead,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def rollback_workflow(
    workflow_id: uuid.UUID,
    version: int,
    session: SessionDep,
    user: CurrentUserDep,
) -> Workflow:
    workflow = await _get_workflow_for_user(session, workflow_id, user)
    target = (
        await session.execute(
            select(WorkflowVersion).where(
                WorkflowVersion.workflow_id == workflow_id,
                WorkflowVersion.version == version,
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Version not found")

    snapshot = target.config_snapshot
    workflow.name = snapshot.get("name", workflow.name)
    workflow.description = snapshot.get("description", workflow.description)
    workflow.agent_chain = snapshot.get("agent_chain", workflow.agent_chain)
    await _snapshot_version(session, workflow, changelog=f"rollback to v{version}")
    await session.commit()
    return workflow


@router.post("/{workflow_id}/validate-dag")
async def validate_dag(
    workflow_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    workflow = await _get_workflow_for_user(session, workflow_id, user)
    dag = workflow.dag_definition or {}
    nodes = [n for n in (dag.get("nodes") or []) if isinstance(n, dict)]
    edges = [e for e in (dag.get("edges") or []) if isinstance(e, dict)]
    ids = {n.get("id") for n in nodes}
    issues: list[str] = []
    if not ids:
        return {"valid": False, "issues": ["DAG 缺少节点"]}

    connected: set[str] = set()
    targets: set[str] = set()
    for edge in edges:
        connected.add(edge.get("source"))
        connected.add(edge.get("target"))
        targets.add(edge.get("target"))

    orphans = sorted(i for i in ids if i not in connected)
    if orphans:
        issues.append(f"存在孤立节点: {', '.join(str(o) for o in orphans)}")

    starts = sorted(i for i in ids if i not in targets)
    if not starts:
        issues.append("缺少起始节点（可能存在环）")

    if _has_cycle(edges):
        issues.append("DAG 存在环")

    return {"valid": not issues, "issues": issues}


def _has_cycle(edges: list[dict]) -> bool:
    graph: dict[str, list[str]] = {}
    for edge in edges:
        graph.setdefault(edge.get("source"), []).append(edge.get("target"))
    visiting: set[str] = set()
    visited: set[str] = set()

    def dfs(node: str) -> bool:
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        for nxt in graph.get(node, []):
            if dfs(nxt):
                return True
        visiting.discard(node)
        visited.add(node)
        return False

    return any(dfs(n) for n in graph)


@router.delete(
    "/{workflow_id}",
    status_code=204,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("resources:write")),
    ],
)
async def delete_workflow(
    workflow_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    workflow = await _get_workflow_for_user(session, workflow_id, user)

    active = await session.execute(
        select(Execution).where(
            Execution.workflow_id == workflow_id,
            Execution.status.in_(
                [
                    ExecutionStatus.PENDING,
                    ExecutionStatus.RUNNING,
                    ExecutionStatus.WAITING_FOR_APPROVAL,
                ]
            ),
        )
    )
    if active.scalars().first() is not None:
        raise HTTPException(
            status_code=409,
            detail="Workflow has pending/running executions and cannot be deleted",
        )

    await session.delete(workflow)
    await session.commit()
