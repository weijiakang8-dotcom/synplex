from __future__ import annotations

import uuid

from sqlalchemy import select

from app.database import async_session_factory
from app.models import Execution, ModelConfig, UsageEvent


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


async def record_execution_usage(execution_id: uuid.UUID | str) -> None:
    async with async_session_factory() as session:
        execution = await session.get(Execution, uuid.UUID(str(execution_id)))
        if execution is None:
            return

        default_stmt = select(ModelConfig).where(
            ModelConfig.is_active.is_(True),
            ModelConfig.is_default.is_(True),
        )
        if execution.organization_id is not None:
            default_stmt = default_stmt.where(
                ModelConfig.organization_id == execution.organization_id
            )
        default_model = (await session.execute(default_stmt)).scalars().first()
        default_rate = (
            float(default_model.cost_per_1k_tokens) if default_model else None
        )

        usage = (execution.checkpoint_data or {}).get("llm_usage") or []
        events = list(
            (
                await session.execute(
                    select(UsageEvent).where(UsageEvent.execution_id == execution.id)
                )
            )
            .scalars()
            .all()
        )
        # Gateway's idempotent call receipts include plan, proposals and hidden subcalls.
        receipts = [event for event in events if isinstance(event, UsageEvent)]
        if receipts:
            persisted_ids = {str(event.id) for event in receipts}
            checkpoint_only = [
                entry
                for entry in usage
                if entry.get("call_id") and entry["call_id"] not in persisted_ids
            ]
            usage = [
                {
                    "model_used": event.model,
                    "input_tokens": event.input_tokens,
                    "output_tokens": event.output_tokens,
                    "cost": event.cost,
                }
                for event in receipts
            ] + checkpoint_only
        if usage:
            model_used: list[str] = []
            token_usage: dict[str, dict[str, int]] = {}
            for entry in usage:
                model = entry.get("model_used")
                if not model:
                    continue
                if model not in model_used:
                    model_used.append(model)
                bucket = token_usage.setdefault(
                    model, {"input_tokens": 0, "output_tokens": 0}
                )
                bucket["input_tokens"] += int(entry.get("input_tokens") or 0)
                bucket["output_tokens"] += int(entry.get("output_tokens") or 0)
            # 按实际响应的模型逐条计价，避免 fallback 后仍按主模型计费。
            model_names = {
                entry.get("model_used") for entry in usage if entry.get("model_used")
            }
            if model_names:
                rate_stmt = select(ModelConfig).where(
                    ModelConfig.model.in_(model_names)
                )
                candidates = list((await session.execute(rate_stmt)).scalars().all())
                org_rates = {
                    model.model: float(model.cost_per_1k_tokens)
                    for model in candidates
                    if model.organization_id == execution.organization_id
                }
                global_rates = {
                    model.model: float(model.cost_per_1k_tokens)
                    for model in candidates
                    if model.organization_id is None
                }
                rates = {**global_rates, **org_rates}
            else:
                rates = {}
            input_tokens = sum(int(entry.get("input_tokens") or 0) for entry in usage)
            output_tokens = sum(int(entry.get("output_tokens") or 0) for entry in usage)
            costs: list[float] = []
            unknown_cost = False
            for entry in usage:
                entry_cost = entry.get("cost")
                if entry_cost is not None:
                    costs.append(float(entry_cost))
                    continue
                tokens = int(entry.get("input_tokens") or 0) + int(
                    entry.get("output_tokens") or 0
                )
                model = entry.get("model_used")
                rate = rates.get(model) if model else None
                if rate is None or tokens <= 0:
                    unknown_cost = True
                    continue
                costs.append(tokens / 1000 * float(rate))
            cost = round(sum(costs), 8) if costs and not unknown_cost else None
        else:
            input_tokens = estimate_tokens(execution.user_input or "")
            output_tokens = estimate_tokens(
                execution.final_output or execution.error_message or ""
            )
            cost = (
                round((input_tokens + output_tokens) / 1000 * default_rate, 8)
                if default_rate is not None
                else None
            )

        execution.input_tokens = input_tokens
        execution.output_tokens = output_tokens
        execution.cost = cost
        if usage:
            execution.model_used = model_used
            execution.token_usage = token_usage
        await session.commit()
