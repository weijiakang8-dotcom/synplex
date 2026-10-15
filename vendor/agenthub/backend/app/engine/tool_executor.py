from __future__ import annotations

import asyncio
import hashlib
import uuid
from contextvars import ContextVar
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.core.failure import (
    TOOL_RETRY_POLICY,
    ErrorCategory,
    classify_error,
    should_retry,
)
from app.database import async_session_factory
from app.engine.canonical import params_canonical
from app.engine.event_bus import publish_execution_event
from app.engine.observability import record_span
from app.engine.tool_registry import get_tool
from app.models import Execution, ToolCall, utcnow
from app.models.enums import ToolCallStatus

current_tool_user_id: ContextVar[str | None] = ContextVar(
    "current_tool_user_id", default=None
)


current_tool_execution_id: ContextVar[str | None] = ContextVar(
    "current_tool_execution_id", default=None
)


def make_idempotency_key(
    execution_id: str | uuid.UUID,
    tool_name: str,
    params: dict[str, Any],
) -> str:
    """Frozen Contract：sha256(execution_id + tool_name + params_canonical)。"""
    payload = params_canonical(params or {}, tool_name=tool_name)
    return hashlib.sha256(
        f"{execution_id}\0{tool_name}\0{payload}".encode()
    ).hexdigest()


def idempotency_decision(status: str | None, *, has_key: bool) -> str:
    """确定性状态机：根据 tool_calls 行状态决定动作。"""
    if status is None:
        return "execute_new"
    if status == ToolCallStatus.PENDING.value:
        return "claim" if has_key else "unknown"
    if status == ToolCallStatus.IN_FLIGHT.value:
        return "unknown"
    if status == ToolCallStatus.SUCCESS.value:
        return "duplicate"
    if status == ToolCallStatus.FAILED.value:
        return "failed"
    if status == ToolCallStatus.REJECTED.value:
        return "rejected"
    # APPROVED 等历史状态：无法证明 provider 是否被调用 → fail-closed
    return "unknown"


def claim_allowed(status: str | None, *, has_key: bool) -> bool:
    return status == ToolCallStatus.PENDING.value and has_key


async def create_tool_call(
    tool_name: str,
    params: dict[str, Any],
    execution_id: str | uuid.UUID,
    *,
    requires_approval: bool = False,
    idempotency_key: str | None = None,
) -> ToolCall:
    """创建 pending 状态的 ToolCall 审计记录。"""
    if not idempotency_key:
        idempotency_key = make_idempotency_key(execution_id, tool_name, params)
    async with async_session_factory() as session:
        execution = await session.get(Execution, uuid.UUID(str(execution_id)))
        tool_call = ToolCall(
            execution_id=uuid.UUID(str(execution_id)),
            tool_name=tool_name,
            input_params=params or {},
            status=ToolCallStatus.PENDING,
            requires_approval=requires_approval,
            idempotency_key=idempotency_key,
            organization_id=execution.organization_id if execution else None,
        )
        session.add(tool_call)
        await session.commit()
        await session.refresh(tool_call)
        return tool_call


async def _find_by_key(
    execution_id: uuid.UUID,
    idempotency_key: str,
) -> ToolCall | None:
    async with async_session_factory() as session:
        result = await session.execute(
            select(ToolCall).where(
                ToolCall.execution_id == execution_id,
                ToolCall.idempotency_key == idempotency_key,
            )
        )
        return result.scalars().first()


async def _find_legacy_ambiguous(
    execution_id: uuid.UUID,
    tool_name: str,
    params: dict[str, Any],
) -> ToolCall | None:
    """历史无 key 行（PENDING/APPROVED/IN_FLIGHT）：无法证明未调用 provider。"""
    async with async_session_factory() as session:
        result = await session.execute(
            select(ToolCall).where(
                ToolCall.execution_id == execution_id,
                ToolCall.tool_name == tool_name,
                ToolCall.idempotency_key.is_(None),
                ToolCall.status.in_(
                    [
                        ToolCallStatus.PENDING,
                        ToolCallStatus.APPROVED,
                        ToolCallStatus.IN_FLIGHT,
                    ]
                ),
            )
        )
        for row in result.scalars().all():
            if params_canonical(
                row.input_params or {}, tool_name=tool_name
            ) == params_canonical(params, tool_name=tool_name):
                return row
    return None


async def _claim_tool_call(tool_call_id: uuid.UUID) -> bool:
    """原子 claim：PENDING → IN_FLIGHT，事务提交后才允许调用 provider。"""
    async with async_session_factory() as session:
        result = await session.execute(
            update(ToolCall)
            .where(
                ToolCall.id == tool_call_id,
                ToolCall.status == ToolCallStatus.PENDING,
            )
            .values(status=ToolCallStatus.IN_FLIGHT, started_at=utcnow())
            .returning(ToolCall.id)
        )
        await session.commit()
        return result.scalar_one_or_none() is not None


def _decision_result(decision: str, row: ToolCall | None) -> dict[str, Any]:
    if decision == "duplicate" and row is not None:
        return {
            "status": "duplicate",
            "data": (
                row.output_result.get("data")
                if isinstance(row.output_result, dict)
                and "status" in row.output_result
                and "data" in row.output_result
                else row.output_result
            ),
            "error": None,
            "idempotent": True,
        }
    if decision == "failed" and row is not None:
        return {
            "status": "failed",
            "data": None,
            "error": str((row.output_result or {}).get("error") or "already failed"),
            "idempotent": True,
        }
    if decision == "rejected":
        return {
            "status": "rejected",
            "data": None,
            "error": "Rejected by human",
            "idempotent": True,
        }
    return {
        "status": "unknown",
        "data": None,
        "error": "side effect state unknown; fail-closed (no provider call)",
        "idempotent": True,
    }


async def _finish_tool_call(
    tool_call_id: uuid.UUID, result: dict[str, Any]
) -> ToolCall:
    async with async_session_factory() as session:
        tool_call = await session.get(ToolCall, tool_call_id)
        if tool_call is None:
            raise RuntimeError(f"ToolCall {tool_call_id} not found")

        tool_call.output_result = result
        tool_call.status = (
            ToolCallStatus.SUCCESS
            if result.get("status") in ("success", "duplicate")
            else ToolCallStatus.FAILED
        )
        tool_call.completed_at = utcnow()
        await session.commit()
        await session.refresh(tool_call)
        return tool_call


async def mark_tool_call_rejected(
    tool_call_id: uuid.UUID, operator: str | None = None
) -> ToolCall:
    async with async_session_factory() as session:
        tool_call = await session.get(ToolCall, tool_call_id)
        if tool_call is None:
            raise RuntimeError(f"ToolCall {tool_call_id} not found")

        tool_call.status = ToolCallStatus.REJECTED
        tool_call.approved_by = operator or "anonymous"
        tool_call.output_result = {
            "status": "rejected",
            "data": None,
            "error": "Rejected by human",
        }
        tool_call.completed_at = utcnow()
        await session.commit()
        await session.refresh(tool_call)
        return tool_call


async def _invoke_with_retry(
    tool_name: str,
    params: dict[str, Any],
    organization_id: uuid.UUID | str | None = None,
) -> dict[str, Any]:
    spec = get_tool(tool_name)
    if spec is None:
        return {
            "status": "failed",
            "data": None,
            "error": f"Unknown tool: {tool_name}",
        }
    if spec.side_effect:
        # Contract 03：副作用工具 claim 后 provider 调用最多一次。
        # TIMEOUT/TRANSIENT/连接丢失等结果不可知的错误 → UNKNOWN（IN_FLIGHT fail-closed），
        # 禁止自动 retry；UNKNOWN 不等于 FAILED，由 reconciliation/query_effect 裁决。
        return await _invoke_side_effect_once(spec, params, organization_id)

    last_error: Exception | None = None
    for attempt in range(TOOL_RETRY_POLICY.max_attempts):
        try:
            result = await asyncio.wait_for(
                spec.handler(params, organization_id),
                timeout=spec.timeout,
            )
            if not isinstance(result, dict):
                result = {"status": "success", "data": result, "error": None}
            return result
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if should_retry(classify_error(exc), "tool") and attempt < (
                TOOL_RETRY_POLICY.max_attempts - 1
            ):
                await asyncio.sleep(TOOL_RETRY_POLICY.delay(attempt))
                continue
            break

    return {
        "status": "failed",
        "data": None,
        "error": str(last_error or "tool execution failed"),
    }


async def _invoke_side_effect_once(
    spec: Any,
    params: dict[str, Any],
    organization_id: uuid.UUID | str | None,
) -> dict[str, Any]:
    """副作用工具单次调用：绝不重试；无法确认结果时返回 UNKNOWN。"""
    try:
        result = await asyncio.wait_for(
            spec.handler(params, organization_id),
            timeout=spec.timeout,
        )
        if not isinstance(result, dict):
            result = {"status": "success", "data": result, "error": None}
        return result
    except Exception as exc:  # noqa: BLE001
        category = classify_error(exc)
        if category in {
            ErrorCategory.TIMEOUT,
            ErrorCategory.TRANSIENT,
            ErrorCategory.INFRASTRUCTURE,
            ErrorCategory.PROVIDER,
        }:
            return {
                "status": "unknown",
                "data": None,
                "error": f"{category.value}: {exc}",
                "idempotent": True,
            }
        return {"status": "failed", "data": None, "error": str(exc)}


async def execute_tool(
    tool_name: str,
    params: dict[str, Any],
    execution_id: str | uuid.UUID,
    *,
    user_id: uuid.UUID | str | None = None,
) -> dict[str, Any]:
    """执行工具并写入完整审计记录。"""
    spec = get_tool(tool_name)
    execution_uuid = uuid.UUID(str(execution_id))
    idempotency_key = make_idempotency_key(execution_id, tool_name, params)

    row = await _find_by_key(execution_uuid, idempotency_key)
    decision = idempotency_decision(
        row.status.value if row else None,
        has_key=bool(row and row.idempotency_key),
    )
    if row is not None and decision in ("duplicate", "failed", "rejected", "unknown"):
        return _decision_result(decision, row)

    # 历史无 key 的歧义行：禁止自动重放
    legacy = await _find_legacy_ambiguous(execution_uuid, tool_name, params)
    if legacy is not None:
        return _decision_result("unknown", legacy)

    if row is None:
        try:
            row = await create_tool_call(
                tool_name,
                params,
                execution_id,
                requires_approval=bool(spec and spec.requires_approval),
                idempotency_key=idempotency_key,
            )
        except IntegrityError:
            # 并发创建：唯一索引保证同键单行；按已有行状态机处理
            row = await _find_by_key(execution_uuid, idempotency_key)
            decision = idempotency_decision(
                row.status.value if row else None,
                has_key=bool(row and row.idempotency_key),
            )
            if row is not None and decision in (
                "duplicate",
                "failed",
                "rejected",
                "unknown",
            ):
                return _decision_result(decision, row)
            if row is None:
                return _decision_result("unknown", None)

    if not await _claim_tool_call(row.id):
        row = await _find_by_key(execution_uuid, idempotency_key)
        decision = idempotency_decision(
            row.status.value if row else None,
            has_key=bool(row and row.idempotency_key),
        )
        return _decision_result(decision, row)

    await publish_execution_event(
        str(execution_id),
        {
            "event": "tool_call",
            "tool_call_id": str(row.id),
            "tool": tool_name,
            "params": params,
        },
    )
    token = current_tool_user_id.set(str(user_id) if user_id else None)
    execution_token = current_tool_execution_id.set(str(execution_id))
    try:
        result = await _invoke_with_retry(tool_name, params, row.organization_id)
    finally:
        current_tool_user_id.reset(token)
        current_tool_execution_id.reset(execution_token)
    await record_span(
        trace_id=str(execution_id),
        name="tool",
        status="ok" if result.get("status") == "success" else "error",
        error=result.get("error"),
        details={
            "tool": tool_name,
            "params": params,
            "duplicate": result.get("status") == "duplicate",
        },
    )
    await publish_execution_event(
        str(execution_id),
        {
            "event": "tool_result",
            "tool_call_id": str(row.id),
            "tool": tool_name,
            "status": result.get("status"),
            "result": result,
        },
    )
    if result.get("status") != "unknown":
        # UNKNOWN：保留 IN_FLIGHT，不落 FAILED，等待 reconciliation / 人工裁决。
        await _finish_tool_call(row.id, result)
    return result


async def execute_pending_tool_call(tool_call_id: uuid.UUID) -> dict[str, Any]:
    """执行一个已存在且待审批的 ToolCall 记录。"""
    async with async_session_factory() as session:
        tool_call = await session.get(ToolCall, tool_call_id)
        if tool_call is None:
            return {"status": "failed", "data": None, "error": "ToolCall not found"}

    decision = idempotency_decision(
        tool_call.status.value,
        has_key=bool(tool_call.idempotency_key),
    )
    if decision in ("duplicate", "failed", "rejected", "unknown"):
        return _decision_result(decision, tool_call)
    if not await _claim_tool_call(tool_call.id):
        async with async_session_factory() as session:
            tool_call = await session.get(ToolCall, tool_call_id)
        decision = idempotency_decision(
            tool_call.status.value if tool_call else None,
            has_key=bool(tool_call and tool_call.idempotency_key),
        )
        return _decision_result(decision, tool_call)

    tool_name = tool_call.tool_name
    params = tool_call.input_params or {}

    await publish_execution_event(
        str(tool_call.execution_id),
        {
            "event": "tool_call",
            "tool_call_id": str(tool_call_id),
            "tool": tool_name,
            "params": params,
        },
    )
    result = await _invoke_with_retry(tool_name, params, tool_call.organization_id)
    await publish_execution_event(
        str(tool_call.execution_id),
        {
            "event": "tool_result",
            "tool_call_id": str(tool_call_id),
            "tool": tool_name,
            "status": result.get("status"),
            "result": result,
        },
    )
    if result.get("status") != "unknown":
        await _finish_tool_call(tool_call_id, result)
    return result
