from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import CurrentUserDep, SessionDep
from app.models import Execution, SynplexTask

router = APIRouter(prefix="/usage", tags=["usage"])


@router.get("")
async def usage(session: SessionDep, user: CurrentUserDep) -> dict:
    stmt = select(
        func.count(Execution.id),
        func.coalesce(func.sum(Execution.input_tokens), 0),
        func.coalesce(func.sum(Execution.output_tokens), 0),
        func.coalesce(func.sum(Execution.cost), 0),
        func.count(Execution.id).filter(Execution.cost.is_(None)),
    )
    if user.organization_id is not None:
        stmt = stmt.where(Execution.organization_id == user.organization_id)
    total_executions, total_input, total_output, total_cost, cost_unknown = (
        await session.execute(stmt)
    ).one()

    today = datetime.now(timezone.utc).date()
    day_stmt = select(
        func.coalesce(func.sum(Execution.input_tokens + Execution.output_tokens), 0),
        func.coalesce(func.sum(Execution.cost), 0),
    )
    if user.organization_id is not None:
        day_stmt = day_stmt.where(Execution.organization_id == user.organization_id)
    day_stmt = day_stmt.where(Execution.created_at >= today)
    today_tokens, today_cost = (await session.execute(day_stmt)).one()

    return {
        "total_executions": total_executions,
        "total_input_tokens": int(total_input),
        "total_output_tokens": int(total_output),
        "total_tokens": int(total_input) + int(total_output),
        "total_cost": float(total_cost or 0),
        "cost_unknown_executions": int(cost_unknown or 0),
        "today_tokens": int(today_tokens or 0),
        "today_cost": float(today_cost or 0),
    }


@router.get("/tokens")
async def tokens(
    user: CurrentUserDep,
    days: int = 30,
) -> dict:
    """token 看板：按模型聚合近 N 天消耗（调度中心数据源）。"""
    from app.core.savings import token_dashboard

    return await token_dashboard(
        str(user.organization_id) if user.organization_id else None,
        days=max(1, min(days, 365)),
    )


@router.get("/savings")
async def savings(user: CurrentUserDep) -> dict:
    """省钱账单：实际成本 vs 全 pro 基线（逐期可查，不伪造数字）。"""
    from app.core.savings import compute_savings, latest_savings

    latest = await latest_savings(
        str(user.organization_id) if user.organization_id else None
    )
    if latest is not None:
        return latest
    return await compute_savings(
        str(user.organization_id) if user.organization_id else None
    )


@router.get("/synplex")
async def runner_usage(session: SessionDep, user: CurrentUserDep) -> dict:
    from app.core.synplex_usage import summarize_runner_usage

    rows = (
        list(
            (
                await session.execute(
                    select(SynplexTask).where(
                        SynplexTask.organization_id == user.organization_id
                    )
                )
            )
            .scalars()
            .all()
        )
        if user.organization_id
        else []
    )
    return summarize_runner_usage(rows)
