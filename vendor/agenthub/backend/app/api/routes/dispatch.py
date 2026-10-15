"""调度中心 API：复杂度预览 / 路由决策审计 / 澄清应答。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep, get_current_user
from app.core.complexity import score_step, score_task
from app.core.routing import build_route, model_candidates, normalize_tier
from app.engine.tasks import resume_workflow_task
from app.models import Clarification, Execution, RoutingDecision
from app.models.base import utcnow
from app.models.enums import ExecutionStatus
from app.skills.matching import match_skills

router = APIRouter(prefix="/dispatch", tags=["dispatch"])


class AnalyzeRequest(BaseModel):
    input: str = Field(..., min_length=1)
    tier: str = "balanced"
    plan: dict | None = None


class ClarificationAnswer(BaseModel):
    answer: str = Field(..., min_length=1, max_length=2000)


def _serialize_decision(decision: RoutingDecision) -> dict:
    return {
        "id": str(decision.id),
        "execution_id": (str(decision.execution_id) if decision.execution_id else None),
        "step_id": decision.step_id,
        "capability": decision.step_capability,
        "score": decision.score,
        "tier": decision.tier,
        "complexity": decision.chosen_complexity,
        "reason": decision.reason,
        "factors": decision.factors,
        "candidates": decision.candidates,
        "outcome": decision.outcome,
        "model_used": decision.model_used,
        "cost": decision.cost,
        "created_at": decision.created_at.isoformat(),
    }


@router.post(
    "/analyze",
    dependencies=[Depends(get_current_user)],
)
async def analyze(payload: AnalyzeRequest, user: CurrentUserDep) -> dict:
    """发布任务前的调度预览（规则评分 + Skill 匹配 + 路由方案，零 LLM 成本）。"""
    tier = normalize_tier(payload.tier)
    intent_hint = {}
    if payload.plan:
        steps = payload.plan.get("steps") or []
        if any(step.get("side_effect") for step in steps):
            intent_hint = {"category": "ACTION", "requires_side_effect": True}
        elif len(steps) > 1:
            intent_hint = {"category": "TASK", "requires_tool": True}
    task_score = score_task(payload.input, intent=intent_hint, plan=payload.plan)
    skills = await match_skills(
        payload.input, str(user.organization_id) if user.organization_id else None
    )
    candidates = await model_candidates(
        str(user.organization_id) if user.organization_id else None
    )
    routing_preview = []
    if payload.plan:
        for step in payload.plan.get("steps") or []:
            step_score = score_step(step, task_score.score)
            choice = build_route(step, step_score, tier=tier, candidates=candidates)
            routing_preview.append(choice.to_dict())
    return {
        "complexity": task_score.to_dict(),
        "tier": tier,
        "skills": skills,
        "candidates": candidates,
        "routing_preview": routing_preview,
    }


@router.get("/decisions")
async def decisions(
    session: SessionDep,
    user: CurrentUserDep,
    execution_id: uuid.UUID | None = None,
    limit: int = 50,
) -> list[dict]:
    """路由决策审计：每一步为什么选这个模型，全部可查可回放。"""
    stmt = select(RoutingDecision).order_by(RoutingDecision.created_at.desc())
    if user.organization_id is not None:
        stmt = stmt.where(RoutingDecision.organization_id == user.organization_id)
    if execution_id is not None:
        stmt = stmt.where(RoutingDecision.execution_id == execution_id)
    stmt = stmt.limit(min(limit, 200))
    result = await session.execute(stmt)
    return [_serialize_decision(decision) for decision in result.scalars().all()]


@router.get("/clarifications")
async def clarifications(
    session: SessionDep,
    user: CurrentUserDep,
    execution_id: uuid.UUID | None = None,
    limit: int = 20,
) -> list[dict]:
    stmt = select(Clarification).order_by(Clarification.created_at.desc())
    if user.organization_id is not None:
        stmt = stmt.where(Clarification.organization_id == user.organization_id)
    if execution_id is not None:
        stmt = stmt.where(Clarification.execution_id == execution_id)
    result = await session.execute(stmt.limit(min(limit, 100)))
    return [
        {
            "id": str(row.id),
            "execution_id": str(row.execution_id) if row.execution_id else None,
            "step_id": row.step_id,
            "question": row.question,
            "options": row.options,
            "answer": row.answer,
            "status": row.status,
            "created_at": row.created_at.isoformat(),
            "answered_at": row.answered_at.isoformat() if row.answered_at else None,
        }
        for row in result.scalars().all()
    ]


@router.post(
    "/clarifications/{clarification_id}/answer",
    status_code=202,
    dependencies=[Depends(get_current_user)],
)
async def answer_clarification(
    clarification_id: uuid.UUID,
    payload: ClarificationAnswer,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    """回答澄清：更新记录 + 从断点恢复执行（用户选择注入上下文，继续任务）。"""
    clarification = await session.get(Clarification, clarification_id)
    if clarification is None or (
        clarification.organization_id is not None
        and clarification.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Clarification not found")
    if clarification.status != "pending":
        raise HTTPException(status_code=409, detail="Clarification already answered")
    clarification.answer = payload.answer
    clarification.status = "answered"
    clarification.answered_at = utcnow()
    await session.commit()

    execution_id = clarification.execution_id
    if execution_id is not None:
        execution = await session.get(Execution, execution_id)
        if (
            execution is None
            or execution.status != ExecutionStatus.WAITING_FOR_APPROVAL
        ):
            raise HTTPException(
                status_code=409, detail="Execution is not waiting for clarification"
            )
        resume_workflow_task.delay(str(execution_id), {"answer": payload.answer})

    return {
        "clarification_id": str(clarification_id),
        "execution_id": str(execution_id) if execution_id else None,
        "status": "resuming",
    }
