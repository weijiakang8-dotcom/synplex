from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.config import settings
from app.database import async_session_factory
from app.engine.evaluator import evaluate_execution
from app.engine.tasks import execute_workflow_task
from app.models import EvalDataset, EvalRun, Execution, Workflow, utcnow
from app.models.enums import ExecutionStatus

router = APIRouter(prefix="/eval", tags=["eval"])


@router.get("/benchmark/latest")
async def latest_benchmark_report(user: CurrentUserDep) -> dict:
    """返回最近一次 Phase 1B 任务级评测报告（只读文件，缺失时 404）。"""
    # 容器内 backend/ 被拷贝为 /app，本地则为仓库根下的 backend/；
    # 以本模块位置推导两种布局下的根目录。
    root = Path(__file__).resolve().parents[3]
    configured = Path(settings.BENCHMARK_REPORT_PATH)
    candidates = []
    if configured.is_absolute():
        candidates.append(configured)
    else:
        candidates.append(root / configured)
        candidates.append(
            root
            / "tests"
            / "benchmark"
            / "phase1"
            / "reports"
            / "evaluation_report.json"
        )
    report_path = next((p for p in candidates if p.exists()), None)
    if report_path is None:
        raise HTTPException(
            status_code=404,
            detail="暂无评测报告：请先运行 Phase 1B Benchmark 生成 evaluation_report.json",
        )
    try:
        return json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="评测报告格式损坏")


class DatasetCreate(BaseModel):
    name: str
    description: str = ""
    items: list[dict]


class RunRequest(BaseModel):
    dataset_id: uuid.UUID
    workflow_id: uuid.UUID | None = None
    threshold: float = 7.0


def _serialize_dataset(d: EvalDataset) -> dict:
    return {
        "id": str(d.id),
        "name": d.name,
        "description": d.description,
        "items": d.items,
        "created_at": d.created_at.isoformat(),
    }


def _serialize_run(r: EvalRun) -> dict:
    return {
        "id": str(r.id),
        "dataset_id": str(r.dataset_id),
        "status": r.status,
        "score": r.score,
        "report": r.report,
        "created_at": r.created_at.isoformat(),
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
    }


@router.get("/datasets")
async def list_datasets(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(EvalDataset).order_by(EvalDataset.created_at.desc())
    if user.organization_id is not None:
        stmt = stmt.where(EvalDataset.organization_id == user.organization_id)
    result = await session.execute(stmt)
    return [_serialize_dataset(d) for d in result.scalars().all()]


@router.post("/datasets", status_code=201)
async def create_dataset(
    payload: DatasetCreate, session: SessionDep, user: CurrentUserDep
) -> dict:
    if not payload.items:
        raise HTTPException(status_code=422, detail="Dataset items cannot be empty")
    dataset = EvalDataset(
        organization_id=user.organization_id,
        name=payload.name,
        description=payload.description,
        items=payload.items,
    )
    session.add(dataset)
    await session.commit()
    await session.refresh(dataset)
    return _serialize_dataset(dataset)


@router.delete("/datasets/{dataset_id}", status_code=204)
async def delete_dataset(
    dataset_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    dataset = await session.get(EvalDataset, dataset_id)
    if dataset is None or (
        user.organization_id is not None
        and dataset.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Dataset not found")
    await session.delete(dataset)
    await session.commit()


@router.get("/reports")
async def list_reports(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(EvalRun).order_by(EvalRun.created_at.desc()).limit(100)
    if user.organization_id is not None:
        stmt = stmt.where(EvalRun.organization_id == user.organization_id)
    result = await session.execute(stmt)
    return [_serialize_run(r) for r in result.scalars().all()]


async def _get_or_create_workflow(
    org_id: uuid.UUID | None, workflow_id: uuid.UUID | None
) -> uuid.UUID:
    async with async_session_factory() as session:
        if workflow_id is not None:
            workflow = await session.get(Workflow, workflow_id)
            if workflow is None or workflow.organization_id != org_id:
                raise HTTPException(status_code=404, detail="Workflow not found")
            return workflow.id

        stmt = select(Workflow).where(Workflow.name == "__eval_default__")
        if org_id is not None:
            stmt = stmt.where(Workflow.organization_id == org_id)
        workflow = (await session.execute(stmt)).scalars().first()
        if workflow is None:
            workflow = Workflow(
                name="__eval_default__",
                description="Eval default workflow",
                agent_chain=[],
                dag_definition=None,
                created_by="system",
                organization_id=org_id,
            )
            session.add(workflow)
            await session.commit()
        return workflow.id


async def _run_one(
    workflow_id: uuid.UUID, user_input: str, org_id: uuid.UUID | None
) -> dict:
    async with async_session_factory() as session:
        execution = Execution(
            workflow_id=workflow_id,
            user_input=user_input,
            status=ExecutionStatus.PENDING,
            current_step_index=0,
            organization_id=org_id,
        )
        session.add(execution)
        await session.commit()
        await session.refresh(execution)
        execution_id = execution.id

    execute_workflow_task.delay(str(execution_id))

    for _ in range(90):
        await asyncio.sleep(1)
        async with async_session_factory() as session:
            execution = await session.get(Execution, execution_id)
            if execution is None:
                return {"input": user_input, "status": "not_found", "score": None}
            if execution.status in {
                ExecutionStatus.COMPLETED,
                ExecutionStatus.FAILED,
                ExecutionStatus.ROLLED_BACK,
            }:
                if (
                    execution.status == ExecutionStatus.COMPLETED
                    and execution.final_output
                ):
                    await evaluate_execution(str(execution_id))
                    async with async_session_factory() as s2:
                        refreshed = await s2.get(Execution, execution_id)
                        return {
                            "input": user_input,
                            "status": refreshed.status.value,
                            "final_output": refreshed.final_output,
                            "score": refreshed.eval_score,
                            "eval_details": refreshed.eval_details,
                        }
                return {
                    "input": user_input,
                    "status": execution.status.value,
                    "final_output": execution.final_output,
                    "score": execution.eval_score,
                    "eval_details": execution.eval_details,
                    "error": execution.error_message,
                }

    return {"input": user_input, "status": "timeout", "score": None}


@router.post("/run", status_code=201)
async def run_eval(payload: RunRequest, user: CurrentUserDep) -> dict:
    async with async_session_factory() as session:
        dataset = await session.get(EvalDataset, payload.dataset_id)
        if dataset is None or (
            user.organization_id is not None
            and dataset.organization_id != user.organization_id
        ):
            raise HTTPException(status_code=404, detail="Dataset not found")

        run = EvalRun(
            dataset_id=dataset.id,
            organization_id=user.organization_id,
            status="running",
            report={},
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        run_id = run.id

    workflow_id = await _get_or_create_workflow(
        user.organization_id, payload.workflow_id
    )
    items = []
    for item in dataset.items:
        if not isinstance(item, dict):
            continue
        user_input = str(item.get("input") or item.get("user_input") or "")
        if not user_input:
            continue
        items.append(await _run_one(workflow_id, user_input, user.organization_id))

    scored = [i for i in items if i.get("score") is not None]
    avg = (
        round(sum(float(i["score"]) for i in scored) / len(scored), 2)
        if scored
        else None
    )
    passed = sum(1 for i in scored if float(i["score"]) >= payload.threshold)
    report = {
        "total": len(items),
        "scored": len(scored),
        "passed": passed,
        "threshold": payload.threshold,
        "average_score": avg,
        "items": items,
    }

    async with async_session_factory() as session:
        run = await session.get(EvalRun, run_id)
        run.status = "completed"
        run.score = avg
        run.report = report
        run.completed_at = utcnow()
        await session.commit()
        await session.refresh(run)
        return _serialize_run(run)
