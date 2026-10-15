from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import CurrentUserDep
from app.core.quota import quota_usage, set_quota_limits

router = APIRouter(prefix="/quotas", tags=["quotas"])


class QuotaUpdate(BaseModel):
    monthly_token_budget: int | None = Field(default=None, ge=0)
    monthly_cost_budget_cny: float | None = Field(default=None, ge=0)
    concurrent_llm_limit: int | None = Field(default=None, ge=0)


@router.get("")
async def get_quota_usage(user: CurrentUserDep) -> dict[str, Any]:
    """返回当前租户的预算与并发用量（只读）。"""
    return await quota_usage(
        str(user.organization_id) if user.organization_id else None
    )


@router.put("")
async def update_quota(payload: QuotaUpdate, user: CurrentUserDep) -> dict[str, Any]:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin permission required")
    if user.organization_id is None:
        raise HTTPException(status_code=400, detail="Organization required")
    await set_quota_limits(
        str(user.organization_id),
        monthly_token_budget=payload.monthly_token_budget,
        monthly_cost_budget_cny=payload.monthly_cost_budget_cny,
        concurrent_llm_limit=payload.concurrent_llm_limit,
    )
    return await quota_usage(str(user.organization_id))


__all__ = ["router"]
