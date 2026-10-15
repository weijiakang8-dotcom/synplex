from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from app.adapters.errors import UnsupportedKernelWorkflowError
from app.api.deps import CurrentUserDep, SessionDep
from app.core.permissions import require_permission
from app.database import async_session_factory
from app.models import Execution, Skill, Workflow
from app.models.base import utcnow
from app.models.enums import ExecutionStatus, WorkflowStatus
from app.skills.growth import propose_growth_skills, recent_usage_signature
from app.skills.matching import match_skills
from app.skills.presets import PRESET_SKILLS, ensure_preset_skills

router = APIRouter(prefix="/skills", tags=["skills"])


class SkillCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    goal: dict
    plan_template: dict
    icon: str = "sparkles"
    runtime: str = "kernel"  # kernel（旧）| agent（调度中心）


class SkillUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    goal: dict | None = None
    plan_template: dict | None = None
    icon: str | None = None
    trigger: str | None = None


class SkillExecute(BaseModel):
    input: str = Field(..., min_length=1)


def _serialize(skill: Skill) -> dict:
    return {
        "id": str(skill.id),
        "name": skill.name,
        "description": skill.description,
        "goal": skill.goal,
        "plan_template": skill.plan_template,
        "icon": skill.icon,
        "organization_id": (
            str(skill.organization_id) if skill.organization_id else None
        ),
        "created_by": str(skill.created_by) if skill.created_by else None,
        "source": skill.source,
        "version": skill.version,
        "status": skill.status,
        "runtime": skill.runtime,
        "trigger": skill.trigger,
        "model_tier_hints": skill.model_tier_hints,
        "times_used": skill.times_used,
        "created_at": skill.created_at,
    }


def _resolve_placeholders(value: Any, user_input: str, execution_id: uuid.UUID) -> Any:
    if isinstance(value, str):
        return value.replace("{input}", user_input).replace(
            "{execution_id}", str(execution_id)
        )
    if isinstance(value, list):
        return [_resolve_placeholders(item, user_input, execution_id) for item in value]
    if isinstance(value, dict):
        return {
            key: _resolve_placeholders(item, user_input, execution_id)
            for key, item in value.items()
        }
    return value


@router.get("")
async def list_skills(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(Skill).where(
        or_(
            Skill.organization_id.is_(None),
            Skill.organization_id == user.organization_id,
        )
    )
    result = await session.execute(stmt.order_by(Skill.created_at))
    return [_serialize(skill) for skill in result.scalars().all()]


@router.post(
    "",
    status_code=201,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def create_skill(
    payload: SkillCreate, session: SessionDep, user: CurrentUserDep
) -> dict:
    skill = Skill(
        name=payload.name,
        description=payload.description,
        goal=payload.goal,
        plan_template=payload.plan_template,
        icon=payload.icon,
        organization_id=user.organization_id,
        created_by=user.id,
        source="user",
        version=1,
        status="active",
        runtime=payload.runtime if payload.runtime in {"kernel", "agent"} else "kernel",
        trigger="",
        model_tier_hints=None,
    )
    session.add(skill)
    await session.commit()
    await session.refresh(skill)
    return _serialize(skill)


@router.put(
    "/{skill_id}",
    dependencies=[Depends(require_permission("resources:write"))],
)
async def update_skill(
    skill_id: uuid.UUID,
    payload: SkillUpdate,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    skill = await session.get(Skill, skill_id)
    if skill is None or skill.created_by != user.id:
        raise HTTPException(status_code=404, detail="Skill not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(skill, field, value)
    await session.commit()
    await session.refresh(skill)
    return _serialize(skill)


@router.delete(
    "/{skill_id}",
    status_code=204,
    dependencies=[Depends(require_permission("resources:write"))],
)
async def delete_skill(
    skill_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    skill = await session.get(Skill, skill_id)
    if skill is None or skill.created_by != user.id:
        raise HTTPException(status_code=404, detail="Skill not found")
    await session.delete(skill)
    await session.commit()


@router.post(
    "/{skill_id}/execute",
    status_code=202,
    dependencies=[Depends(require_permission("executions:write"))],
)
async def execute_skill(
    skill_id: uuid.UUID,
    payload: SkillExecute,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    skill = await session.get(Skill, skill_id)
    if skill is None or (
        skill.organization_id is not None
        and skill.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Skill not found")

    workflow = Workflow(
        name=f"skill:{skill.name}",
        description=skill.description,
        agent_chain=[],
        dag_definition={"kernel_plan": skill.plan_template},
        status=WorkflowStatus.ACTIVE,
        created_by=str(user.id),
        organization_id=user.organization_id,
    )
    session.add(workflow)
    await session.commit()
    await session.refresh(workflow)

    execution = Execution(
        workflow_id=workflow.id,
        user_input=payload.input,
        status=ExecutionStatus.PENDING,
        current_step_index=0,
        organization_id=user.organization_id,
        user_id=user.id,
    )
    session.add(execution)
    await session.commit()
    await session.refresh(execution)

    # 用占位符解析后的计划覆写（{input}/{execution_id} 由真实用户输入替换）。
    resolved = _resolve_placeholders(skill.plan_template, payload.input, execution.id)
    workflow.dag_definition = {"kernel_plan": resolved}
    await session.commit()

    from app.adapters.kernel_runner import run_kernel_execution

    try:
        await run_kernel_execution(execution.id)
    except UnsupportedKernelWorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async with async_session_factory() as read_session:
        refreshed = await read_session.get(Execution, execution.id)
    return {
        "execution_id": str(execution.id),
        "status": refreshed.status.value if refreshed else "pending",
    }


# —— 调度中心（二次装修新增）：预设包 / 匹配 / 自成长 ——


@router.post(
    "/seed-presets",
    status_code=201,
    dependencies=[Depends(require_permission("operations:manage"))],
)
async def seed_presets() -> dict:
    """幂等播种全局预设 Skill 包。"""
    created = await ensure_preset_skills()
    return {"created": created, "presets": [item["name"] for item in PRESET_SKILLS]}


@router.get("/match")
async def match(
    input: str,
    session: SessionDep,
    user: CurrentUserDep,
) -> list[dict]:
    """任务文本 → 候选 Skill（触发词 + 文本相似）。"""
    return await match_skills(
        input,
        str(user.organization_id) if user.organization_id else None,
    )


@router.post("/{skill_id}/adopt", status_code=201)
async def adopt_skill(
    skill_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    """采纳预设/他人 Skill 到本租户（复制一份，互不影响、可自成长）。"""
    skill = await session.get(Skill, skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    if (
        skill.organization_id is not None
        and skill.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Skill not found")
    if skill.organization_id == user.organization_id:
        raise HTTPException(status_code=409, detail="Skill already owned by your org")
    copy = Skill(
        name=skill.name,
        description=skill.description,
        goal=skill.goal,
        plan_template=skill.plan_template,
        icon=skill.icon,
        organization_id=user.organization_id,
        created_by=user.id,
        source="user" if skill.source == "preset" else skill.source,
        version=1,
        status="active",
        runtime=skill.runtime,
        trigger=skill.trigger,
        model_tier_hints=skill.model_tier_hints,
    )
    session.add(copy)
    await session.commit()
    await session.refresh(copy)
    return _serialize(copy)


@router.get("/growth/candidates")
async def growth_candidates(session: SessionDep, user: CurrentUserDep) -> dict:
    """自成长候选 + 平台看到的任务模式。"""
    org = str(user.organization_id) if user.organization_id else None
    stmt = select(Skill).where(
        Skill.organization_id == user.organization_id,
        Skill.source == "auto",
        Skill.status == "proposed",
    )
    result = await session.execute(stmt.order_by(Skill.created_at.desc()))
    proposals = [
        {
            "id": str(skill.id),
            "name": skill.name,
            "description": skill.description,
            "icon": skill.icon,
            "created_at": skill.created_at,
        }
        for skill in result.scalars().all()
    ]
    return {
        "proposals": proposals,
        "patterns": await recent_usage_signature(org),
    }


@router.post("/growth/run")
async def growth_run(session: SessionDep, user: CurrentUserDep) -> dict:
    """立即扫描使用数据，生成自成长候选（幂等）。"""
    proposals = await propose_growth_skills(
        str(user.organization_id) if user.organization_id else None
    )
    return {"proposals": proposals}


@router.post("/growth/{skill_id}/accept")
async def growth_accept(
    skill_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    skill = await session.get(Skill, skill_id)
    if skill is None or skill.organization_id != user.organization_id:
        raise HTTPException(status_code=404, detail="Skill not found")
    if skill.source != "auto" or skill.status != "proposed":
        raise HTTPException(
            status_code=409, detail="Only proposed auto skills can be accepted"
        )
    skill.status = "active"
    await session.commit()
    return _serialize(skill)


@router.post("/growth/{skill_id}/reject")
async def growth_reject(
    skill_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    skill = await session.get(Skill, skill_id)
    if skill is None or skill.organization_id != user.organization_id:
        raise HTTPException(status_code=404, detail="Skill not found")
    skill.status = "retired"
    await session.commit()
    return _serialize(skill)


@router.post("/{skill_id}/use", status_code=201)
async def mark_skill_used(
    skill_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    """记录 Skill 使用（times_used/last_used_at，自成长统计原料）。"""
    skill = await session.get(Skill, skill_id)
    if skill is None or (
        skill.organization_id is not None
        and skill.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Skill not found")
    skill.times_used += 1
    skill.last_used_at = utcnow()
    await session.commit()
    return _serialize(skill)
