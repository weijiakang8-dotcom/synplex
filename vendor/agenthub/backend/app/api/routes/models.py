from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.core import model_catalog
from app.core.model_gateway import test_model
from app.core.permissions import require_permission
from app.models import ModelConfig

router = APIRouter(prefix="/models", tags=["models"])


class ModelCreate(BaseModel):
    name: str
    provider: str
    base_url: str
    api_key: str = ""
    model: str
    max_tokens: int = 4096
    cost_per_1k_tokens: float = 0.0
    priority: int = 100
    timeout: int = 120
    max_retries: int = 2
    enabled: bool = True
    is_default: bool = False


class ModelUpdate(BaseModel):
    name: str | None = None
    provider: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    max_tokens: int | None = None
    cost_per_1k_tokens: float | None = None
    priority: int | None = None
    timeout: int | None = None
    max_retries: int | None = None
    enabled: bool | None = None
    is_active: bool | None = None
    is_default: bool | None = None


def _serialize(m: ModelConfig) -> dict:
    return {
        "id": str(m.id),
        "name": m.name,
        "provider": m.provider,
        "base_url": m.base_url,
        "model": m.model,
        "max_tokens": m.max_tokens,
        "cost_per_1k_tokens": m.cost_per_1k_tokens,
        "priority": m.priority,
        "timeout": m.timeout,
        "max_retries": m.max_retries,
        "enabled": m.enabled,
        "is_active": m.is_active,
        "is_default": m.is_default,
    }


@router.get("")
async def list_models(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(ModelConfig)
    if user.organization_id is not None:
        stmt = stmt.where(ModelConfig.organization_id == user.organization_id)
    result = await session.execute(stmt.order_by(ModelConfig.created_at))
    return [_serialize(m) for m in result.scalars().all()]


def _selection_entry(config: ModelConfig) -> dict:
    """把组织已配置的模型整理成选择器需要的形状。

    思考等级来自内置目录：目录里没有的模型（自建、代理）按"不支持等级"处理，
    避免界面给出实际上游不认的选项。
    """
    provider = str(config.provider or "").split(":", 1)[0].lower()
    entry = model_catalog.find_model(provider, config.model)
    capabilities = (config.config or {}).get("capabilities") or {}
    return {
        "id": str(config.id),
        "provider": provider,
        "model": config.model,
        "display_name": (entry.display_name if entry else config.name),
        "tier": entry.tier if entry else "custom",
        "context_window": capabilities.get(
            "context_window", entry.context_window if entry else None
        ),
        "supports_tools": bool(
            capabilities.get("tool_calling", entry.supports_tools if entry else True)
        ),
        "supports_vision": bool(
            capabilities.get("vision", entry.supports_vision if entry else False)
        ),
        "default_reasoning": (
            (config.config or {}).get("reasoning_effort")
            or (entry.default_reasoning if entry else None)
        ),
        "verified": bool(entry.verified) if entry else False,
        "reasoning": (
            [
                {
                    "id": option.id,
                    "name": option.name,
                    "description": option.description,
                }
                for option in entry.reasoning
            ]
            if entry
            else []
        ),
    }


@router.get("/options")
async def model_options(session: SessionDep, user: CurrentUserDep) -> dict:
    """对话输入框用的模型清单：只列当前租户已启用、可选的模型。"""
    stmt = select(ModelConfig).where(
        ModelConfig.enabled.is_(True), ModelConfig.is_active.is_(True)
    )
    if user.organization_id is not None:
        stmt = stmt.where(ModelConfig.organization_id == user.organization_id)
    result = await session.execute(stmt.order_by(ModelConfig.priority))
    entries = [_selection_entry(m) for m in result.scalars().all()]

    grouped: dict[str, dict] = {}
    for entry in entries:
        group = grouped.setdefault(
            entry["provider"],
            {
                "provider": entry["provider"],
                "provider_name": (
                    model_catalog.find_provider(entry["provider"]).name
                    if model_catalog.find_provider(entry["provider"])
                    else entry["provider"]
                ),
                "models": [],
            },
        )
        group["models"].append(entry)
    return {
        "providers": list(grouped.values()),
        "auto": {"label": "自动（按任务复杂度选）", "value": None},
    }


@router.post(
    "",
    status_code=201,
    dependencies=[Depends(require_permission("models:manage"))],
)
async def create_model(
    payload: ModelCreate, session: SessionDep, user: CurrentUserDep
) -> dict:
    model = ModelConfig(
        organization_id=user.organization_id,
        **payload.model_dump(),
    )
    session.add(model)
    await session.commit()
    await session.refresh(model)
    return _serialize(model)


@router.put(
    "/{model_id}",
    dependencies=[Depends(require_permission("models:manage"))],
)
async def update_model(
    model_id: uuid.UUID,
    payload: ModelUpdate,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    model = await session.get(ModelConfig, model_id)
    if model is None or (
        user.organization_id is not None
        and model.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Model not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(model, key, value)
    await session.commit()
    await session.refresh(model)
    return _serialize(model)


@router.post(
    "/{model_id}/test",
    dependencies=[Depends(require_permission("models:manage"))],
)
async def test_model_endpoint(
    model_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    model = await session.get(ModelConfig, model_id)
    if model is None or (
        user.organization_id is not None
        and model.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Model not found")
    return await test_model(model)
