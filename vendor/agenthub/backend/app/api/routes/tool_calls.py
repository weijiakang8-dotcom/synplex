import uuid

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.models import Execution, ToolCall, utcnow
from app.models.enums import ExecutionStatus, ToolCallStatus
from app.schemas.tool_call import ToolCallRead

router = APIRouter(prefix="/tool_calls", tags=["tool_calls"])


@router.get("", response_model=list[ToolCallRead])
async def list_tool_calls(
    session: SessionDep,
    user: CurrentUserDep,
    execution_id: uuid.UUID | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[ToolCall]:
    stmt = select(ToolCall)
    if user.organization_id is not None:
        stmt = stmt.where(ToolCall.organization_id == user.organization_id)
    if execution_id is not None:
        stmt = stmt.where(ToolCall.execution_id == execution_id)
    stmt = stmt.order_by(ToolCall.started_at).offset(skip).limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


@router.get("/{tool_call_id}", response_model=ToolCallRead)
async def get_tool_call(
    tool_call_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> ToolCall:
    tool_call = await session.get(ToolCall, tool_call_id)
    if tool_call is None:
        raise HTTPException(status_code=404, detail="Tool call not found")
    if (
        user.organization_id is not None
        and tool_call.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Tool call not found")
    return tool_call


@router.post("/{tool_call_id}/approve", response_model=ToolCallRead)
async def approve_tool_call(
    tool_call_id: uuid.UUID, user: CurrentUserDep, session: SessionDep
) -> ToolCall:
    tool_call = await session.get(ToolCall, tool_call_id)
    if tool_call is None:
        raise HTTPException(status_code=404, detail="Tool call not found")
    if (
        user.organization_id is not None
        and tool_call.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Tool call not found")

    tool_call.status = ToolCallStatus.APPROVED
    tool_call.approved_by = user.email or str(user.id)
    tool_call.completed_at = utcnow()

    execution = await session.get(Execution, tool_call.execution_id)
    if (
        execution is not None
        and execution.status == ExecutionStatus.WAITING_FOR_APPROVAL
    ):
        execution.status = ExecutionStatus.RUNNING

    await session.commit()
    await session.refresh(tool_call)
    return tool_call


@router.post("/{tool_call_id}/reject", response_model=ToolCallRead)
async def reject_tool_call(
    tool_call_id: uuid.UUID, user: CurrentUserDep, session: SessionDep
) -> ToolCall:
    tool_call = await session.get(ToolCall, tool_call_id)
    if tool_call is None:
        raise HTTPException(status_code=404, detail="Tool call not found")
    if (
        user.organization_id is not None
        and tool_call.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Tool call not found")

    tool_call.status = ToolCallStatus.REJECTED
    tool_call.approved_by = user.email or str(user.id)
    tool_call.completed_at = utcnow()

    execution = await session.get(Execution, tool_call.execution_id)
    if execution is not None:
        execution.status = ExecutionStatus.FAILED
        execution.error_message = f"Tool call rejected: {tool_call.tool_name}"
        execution.completed_at = utcnow()

    await session.commit()
    await session.refresh(tool_call)
    return tool_call
