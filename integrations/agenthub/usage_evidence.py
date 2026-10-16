"""Private-engine usage provenance; never turn an unverified price into free use.

Legacy execution totals cannot identify provider observations versus estimates.
Expose scoped receipt evidence and preserve unknown costs without editing assets.
"""
import uuid

from sqlalchemy import select, func
from sqlalchemy.orm import noload


async def unknown_price(session, execution):
    from app.models import ModelConfig, UsageEvent
    models = list((await session.execute(select(ModelConfig).where(
        ModelConfig.organization_id == execution.organization_id))).scalars())
    unknown = {row.model for row in models if (row.config or {}).get("pricingStatus") == "unknown"}
    if not unknown:
        return False
    receipts = list((await session.execute(select(UsageEvent.model, UsageEvent.cost).where(
        UsageEvent.execution_id == execution.id))).all())
    if receipts:
        return any(row.model in unknown and row.cost is None for row in receipts)
    selected = (execution.model_selection or {}).get("model")
    return selected in unknown or any(row.is_default and row.model in unknown for row in models)


async def save_unknown_total(session, execution):
    from app.core.billing import estimate_tokens
    from app.models import UsageEvent
    receipts = list((await session.execute(select(UsageEvent).where(UsageEvent.execution_id == execution.id))).scalars())
    entries = [{"call_id": str(row.id), "model_used": row.model,
                "input_tokens": row.input_tokens, "output_tokens": row.output_tokens} for row in receipts]
    persisted = {item["call_id"] for item in entries}
    entries.extend(item for item in (execution.checkpoint_data or {}).get("llm_usage", [])
                   if item.get("call_id") and item["call_id"] not in persisted)
    execution.cost = None
    if entries:
        tokens = {}
        for item in entries:
            name = item.get("model_used")
            if name:
                bucket = tokens.setdefault(name, {"input_tokens": 0, "output_tokens": 0})
                for key in bucket:
                    bucket[key] += int(item.get(key) or 0)
        execution.input_tokens = sum(int(item.get("input_tokens") or 0) for item in entries)
        execution.output_tokens = sum(int(item.get("output_tokens") or 0) for item in entries)
        execution.model_used, execution.token_usage = list(tokens), tokens
    else:
        execution.input_tokens = estimate_tokens(execution.user_input or "")
        execution.output_tokens = estimate_tokens(execution.final_output or execution.error_message or "")
    await session.commit()


def install_runtime():
    from app.core import billing
    from app.database import async_session_factory
    from app.engine import runner
    from app.models import Execution
    original = billing.record_execution_usage
    if getattr(original, "synplex_unknown_price", False):
        runner.record_execution_usage = original
        return

    async def record(execution_id):
        async with async_session_factory() as session:
            execution = await session.get(Execution, uuid.UUID(str(execution_id)), options=[noload("*")], with_for_update=True)
            if execution and await unknown_price(session, execution):
                # One locked transaction: never briefly persist the legacy zero.
                await save_unknown_total(session, execution)
                return
        await original(execution_id)
    record.synplex_unknown_price = True
    billing.record_execution_usage = record
    runner.record_execution_usage = record


async def projection(session, execution):
    from app.models import UsageEvent, AuditLog
    rows = (await session.execute(select(UsageEvent.model, UsageEvent.status,
        func.count().label("count"), func.sum(UsageEvent.input_tokens).label("input"),
        func.sum(UsageEvent.output_tokens).label("output"), func.min(UsageEvent.input_tokens).label("minimum_input"),
        func.min(UsageEvent.output_tokens).label("minimum_output"))
        .where(UsageEvent.execution_id == execution.id).group_by(UsageEvent.model, UsageEvent.status).limit(101))).all()
    valid = bool(rows) and len(rows) <= 100 and all(row.model and row.status in {"success", "estimated", "partial", "partial_estimate"}
        and row.input is not None and row.output is not None and row.minimum_input >= 0 and row.minimum_output >= 0 for row in rows)
    failed_calls = (await session.execute(select(func.count()).select_from(AuditLog).where(
        AuditLog.resource_id == str(execution.id), AuditLog.action == "span:llm",
        AuditLog.details["status"].as_string() == "error"))).scalar_one()
    complete = valid and execution.status.value == "completed" and not failed_calls and not any(
        row.status.startswith("partial") for row in rows)
    observed = valid and all(row.status in {"success", "partial"} for row in rows)
    models = {row.model for row in rows} if valid else set()
    return {"protocol": "synplex.engine-usage/1", "executionId": str(execution.id), "workflowId": str(execution.workflow_id),
        "recordedCalls": sum(row.count for row in rows), "coverage": "completed_recorded_calls" if complete else "partial_or_unknown",
        "model": next(iter(models)) if len(models) == 1 else None,
        "inputTokens": sum(row.input for row in rows) if valid else None,
        "outputTokens": sum(row.output for row in rows) if valid else None,
        "provenance": "provider_receipt" if observed else "estimate" if valid else "unknown",
        "paidUsd": None, "priceStatus": "unknown", "failedCallSpans": failed_calls,
        "verification": await verification_projection(session, execution)}


async def verification_projection(session, execution):
    """Project the existing scoped audit, not a new model judgement."""
    from app.models import AuditLog
    rows = list((await session.execute(select(AuditLog).where(
        AuditLog.resource_id == str(execution.id),
        AuditLog.organization_id == execution.organization_id,
        AuditLog.user_id == execution.user_id,
        AuditLog.action == 'verification_feedback')
        .order_by(AuditLog.created_at).limit(2))).scalars())
    status, checks, recorded = 'UNKNOWN', [], execution.completed_at
    if len(rows) == 1:
        from document_delivery import parse_verification
        import json
        parsed = parse_verification(json.dumps(rows[0].details))
        if parsed:
            status, checks, recorded = parsed['verdict'], parsed['checks'], rows[0].created_at
    return {'executionId': str(execution.id), 'workflowId': str(execution.workflow_id),
            'status': status, 'checks': checks,
            'recordedAt': recorded.isoformat() if recorded else None}


def install_api(app, data):
    from fastapi import APIRouter, HTTPException
    from app.api.deps import SessionDep, CurrentUserDep
    from app.models import Execution
    router = APIRouter()

    @router.get("/api/synplex/executions/{execution_id}/usage")
    async def usage(execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep):
        execution = await session.get(Execution, execution_id, options=[noload("*")])
        from tenant_identity import execution_identity
        if (not await execution_identity(session, data, execution)
                or execution.organization_id != user.organization_id or execution.user_id != user.id):
            raise HTTPException(404, "没有找到这次任务的用量记录。")
        return await projection(session, execution)

    app.include_router(router)
