"""会话级模型选择：把用户选定的（厂商、模型、思考等级）解析成可用配置。

设计原则：
1. 显式选择优先且不打折。用户选了 pro 就必须跑 pro，不被复杂度路由改写。
2. 命中不了就报明确错误码，不静默降级到别的模型——静默降级会让用户以为
   选了 pro、实际跑的是 flash，质量与成本都对不上。
3. 思考等级按模型校验，不支持的等级直接拒绝。
"""

from __future__ import annotations

from typing import Any

from app.core import model_catalog

MODEL_NOT_AVAILABLE = "MODEL_NOT_AVAILABLE"
UNSUPPORTED_REASONING_EFFORT = "UNSUPPORTED_REASONING_EFFORT"
MODEL_SELECTION_INVALID = "MODEL_SELECTION_INVALID"


class ModelSelectionError(Exception):
    """带稳定错误码的选择失败，供 API 层原样返回给前端。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize(value: Any) -> str:
    return str(value or "").strip()


def normalize_selection(payload: dict[str, Any] | None) -> dict[str, str]:
    """从会话或请求里取出三元组，空值一律归一为 ``""`` 以便比较。"""
    data = payload or {}
    return {
        "provider": _normalize(data.get("provider")).lower(),
        "model": _normalize(data.get("model")),
        "reasoning_effort": _normalize(data.get("reasoning_effort")).lower(),
    }


def validate_effort(provider: str, model: str, effort: str) -> str:
    """校验等级是否被该模型支持；空值回落到目录默认等级。"""
    entry = model_catalog.find_model(provider, model)
    if entry is None:
        # 目录里没有这个模型：不做臆测，保留管理员填写的原值。
        return effort
    options = {option.id for option in entry.reasoning}
    if not effort:
        return entry.default_reasoning or ""
    if not options:
        raise ModelSelectionError(
            UNSUPPORTED_REASONING_EFFORT,
            f"模型 {provider}/{model} 不支持思考等级设置",
        )
    if effort not in options:
        supported = "、".join(sorted(options))
        raise ModelSelectionError(
            UNSUPPORTED_REASONING_EFFORT,
            f"模型 {provider}/{model} 不支持思考等级 {effort}，可选：{supported}",
        )
    return effort


def available_options() -> list[dict[str, Any]]:
    """目录全量（管理员配置界面用），含未核对条目的标注。"""
    return [
        {
            "provider": provider.id,
            "provider_name": provider.name,
            "base_url": provider.base_url,
            "api_mode": provider.api_mode,
            "models": [
                {
                    "model": item.model,
                    "display_name": item.display_name,
                    "tier": item.tier,
                    "context_window": item.context_window,
                    "supports_tools": item.supports_tools,
                    "supports_vision": item.supports_vision,
                    "default_reasoning": item.default_reasoning,
                    "verified": item.verified,
                    "note": item.note,
                    "reasoning": [
                        {
                            "id": option.id,
                            "name": option.name,
                            "description": option.description,
                        }
                        for option in item.reasoning
                    ],
                }
                for item in provider.models
            ],
        }
        for provider in model_catalog.list_providers()
    ]


async def resolve_selection(
    organization_id: Any,
    selection: dict[str, Any] | None,
    *,
    active_models: list[Any] | None = None,
) -> tuple[Any, str] | None:
    """把选择解析成 ``(ModelConfig, 生效等级)``；未做选择返回 ``None``。

    ``active_models`` 可传入已查询好的组织模型列表，避免重复查库。
    """
    wanted = normalize_selection(selection)
    if not wanted["provider"] or not wanted["model"]:
        return None

    models = active_models
    if models is None:
        # 延迟导入：model_gateway 依赖本模块的调用方，避免循环导入。
        from app.core.model_gateway import list_active_models

        models = await list_active_models(organization_id)

    match = next(
        (
            item
            for item in models
            if str(getattr(item, "provider", "")).lower() == wanted["provider"]
            and str(getattr(item, "model", "")).strip() == wanted["model"]
        ),
        None,
    )
    if match is None:
        raise ModelSelectionError(
            MODEL_NOT_AVAILABLE,
            f"当前租户未启用 {wanted['provider']}/{wanted['model']}，"
            "请先在模型设置中配置该模型",
        )

    effort = validate_effort(
        wanted["provider"], wanted["model"], wanted["reasoning_effort"]
    )
    return match, effort
