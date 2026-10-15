"""Agent 中心 API：自带 Agent 阵容 + 版本化自更新 + 回滚。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agents import get_active_version, get_agent_spec, list_agent_specs
from app.agents.updater import (
    activate_agent_version,
    list_agent_versions,
    propose_agent_update,
    rollback_agent,
)
from app.api.deps import CurrentUserDep, get_current_user

router = APIRouter(prefix="/agent-center", tags=["agent-center"])


class AgentUpdateRequest(BaseModel):
    change_note: str = Field(..., min_length=1, max_length=500)
    examples: list[str] = Field(default_factory=list, max_length=5)
    metrics: dict | None = None


@router.get("", dependencies=[Depends(get_current_user)])
async def agent_roster(user: CurrentUserDep) -> list[dict]:
    """自带 Agent 阵容 + 各 Agent 当前生效版本。"""
    org = str(user.organization_id) if user.organization_id else None
    roster = []
    for spec in list_agent_specs():
        active = await get_active_version(spec.name, org)
        roster.append(
            {
                "name": spec.name,
                "role": spec.role,
                "model_policy": spec.model_policy,
                "active_version": active.version if active else None,
                "active_system_prompt_preview": (
                    active.system_prompt[:200] if active else spec.system_prompt[:200]
                ),
                "default_prompt_preview": spec.system_prompt[:200],
            }
        )
    return roster


@router.get("/{name}/versions", dependencies=[Depends(get_current_user)])
async def agent_versions(name: str, user: CurrentUserDep) -> list[dict]:
    if get_agent_spec(name) is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return await list_agent_versions(
        name, str(user.organization_id) if user.organization_id else None
    )


@router.post(
    "/{name}/update",
    status_code=201,
    dependencies=[Depends(get_current_user)],
)
async def agent_update(
    name: str, payload: AgentUpdateRequest, user: CurrentUserDep
) -> dict:
    """自更新：生成候选版本（结构 + 指标门禁），通过后可激活。"""
    if get_agent_spec(name) is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    result = await propose_agent_update(
        name,
        organization_id=str(user.organization_id) if user.organization_id else None,
        change_note=payload.change_note,
        examples=payload.examples,
        metrics=payload.metrics,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error"))
    return result


@router.post(
    "/versions/{version_id}/activate",
    dependencies=[Depends(get_current_user)],
)
async def agent_activate(version_id: uuid.UUID, user: CurrentUserDep) -> dict:
    result = await activate_agent_version(version_id)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error"))
    return result


@router.post(
    "/{name}/rollback",
    dependencies=[Depends(get_current_user)],
)
async def agent_rollback(name: str, user: CurrentUserDep) -> dict:
    if get_agent_spec(name) is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    result = await rollback_agent(
        name, str(user.organization_id) if user.organization_id else None
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error"))
    return result
