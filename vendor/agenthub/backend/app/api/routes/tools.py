from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CurrentUserDep
from app.engine.tool_registry import list_tools

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("")
async def list_available_tools(user: CurrentUserDep) -> list[dict]:
    """返回当前运行时真实注册的工具清单（唯一事实源：tool_registry）。"""
    return list_tools(organization_id=user.organization_id)


__all__ = ["router"]
