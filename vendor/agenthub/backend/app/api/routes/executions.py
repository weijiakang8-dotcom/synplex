import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, update

from app.api.deps import CurrentUserDep, SessionDep, get_current_user
from app.core.permissions import require_permission
from app.core.telemetry import get_meter, get_tracer
from app.engine.activity import activity_event
from app.engine.outbox import enqueue_outbox_event
from app.models import (
    AuditLog,
    Execution,
    ExecutionEvent,
    ExecutionFeedback,
    InterventionLog,
    ToolCall,
    Workflow,
    utcnow,
)
from app.models.enums import ExecutionStatus
from app.schemas.execution import (
    ExecutionAccepted,
    ExecutionCreate,
    ExecutionDetail,
    ExecutionRead,
    ExecutionResume,
    ExecutionTrace,
    FeedbackCreate,
    SpanSummary,
)
from app.schemas.tool_call import ToolCallRead, ToolCallSummary

router = APIRouter(prefix="/executions", tags=["executions"])

tracer = get_tracer("agenthub.api")
execution_counter = get_meter("agenthub.api").create_counter(
    "execution.started.total",
    description="Total number of executions started",
)


class InterveneRequest(BaseModel):
    operator: str = "admin"
    action: str
    modified_plan: str | None = None


@router.get("", response_model=list[ExecutionRead])
async def list_executions(
    session: SessionDep,
    user: CurrentUserDep,
    workflow_id: uuid.UUID | None = None,
    status: ExecutionStatus | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[Execution]:
    stmt = select(Execution)
    if user.organization_id is not None:
        stmt = stmt.where(Execution.organization_id == user.organization_id)
    if workflow_id is not None:
        stmt = stmt.where(Execution.workflow_id == workflow_id)
    if status is not None:
        stmt = stmt.where(Execution.status == status)
    stmt = stmt.order_by(Execution.created_at.desc()).offset(skip).limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


@router.get("/{execution_id}", response_model=ExecutionDetail)
async def get_execution(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> ExecutionDetail:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")

    detail = ExecutionDetail.model_validate(execution)
    result = await session.execute(
        select(ToolCall)
        .where(ToolCall.execution_id == execution_id)
        .order_by(ToolCall.started_at)
    )
    detail.tool_calls = [
        ToolCallRead.model_validate(tc) for tc in result.scalars().all()
    ]
    return detail


@router.get("/{execution_id}/activity")
async def get_execution_activity(
    execution_id: uuid.UUID,
    session: SessionDep,
    user: CurrentUserDep,
    after: int = Query(default=0, ge=0),
) -> dict:
    """Read-only recovery: paging this endpoint never starts or resumes a task."""
    execution = await session.get(Execution, execution_id)
    if execution is None or (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")
    # Unlike administrative execution views, the chat feed is scoped to its owner.
    if execution.user_id != user.id:
        raise HTTPException(status_code=404, detail="Execution not found")
    events = list(
        (
            await session.execute(
                select(ExecutionEvent)
                .where(
                    ExecutionEvent.execution_id == execution_id,
                    ExecutionEvent.sequence > after,
                )
                .order_by(ExecutionEvent.sequence)
                .limit(200)
            )
        ).scalars()
    )
    snapshot = ExecutionRead.model_validate(execution).model_dump(mode="json")
    snapshot["checkpoint_data"] = {
        "delivery": (execution.checkpoint_data or {}).get("delivery")
    }
    snapshot["plan"] = None
    snapshot["intent"] = None
    return {
        "execution": snapshot,
        "events": [activity_event(event.payload) for event in events],
        "cursor": events[-1].sequence if events else after,
        "has_more": len(events) == 200,
        "heartbeat_at": (
            execution.heartbeat_at.isoformat() if execution.heartbeat_at else None
        ),
    }


@router.get("/{execution_id}/tool_calls", response_model=list[ToolCallRead])
async def list_execution_tool_calls(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> list[ToolCall]:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")

    result = await session.execute(
        select(ToolCall)
        .where(ToolCall.execution_id == execution_id)
        .order_by(ToolCall.started_at)
    )
    return list(result.scalars().all())


@router.post(
    "",
    response_model=ExecutionAccepted,
    status_code=202,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("executions:write")),
    ],
)
async def create_execution(
    payload: ExecutionCreate, session: SessionDep, user: CurrentUserDep
) -> ExecutionAccepted:
    with tracer.start_as_current_span("create_execution") as span:
        span.set_attribute("workflow_id", str(payload.workflow_id))
        span.set_attribute("user_input_length", len(payload.user_input))

        workflow = await session.get(Workflow, payload.workflow_id)
        if workflow is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        if (
            user.organization_id is not None
            and workflow.organization_id != user.organization_id
        ):
            raise HTTPException(status_code=404, detail="Workflow not found")

        execution = Execution(
            workflow_id=payload.workflow_id,
            user_input=payload.user_input,
            status=ExecutionStatus.PENDING,
            current_step_index=0,
            organization_id=user.organization_id,
            user_id=user.id,
        )
        session.add(execution)
        await session.flush()
        await enqueue_outbox_event(
            session,
            "execute_workflow",
            {"execution_id": str(execution.id)},
            execution_id=execution.id,
        )
        await session.commit()
        await session.refresh(execution)
        execution_counter.add(1, {"workflow_id": str(payload.workflow_id)})

        return ExecutionAccepted(
            execution_id=execution.id, status=ExecutionStatus.PENDING
        )


@router.post(
    "/{execution_id}/cancel",
    response_model=ExecutionRead,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("executions:write")),
    ],
)
async def cancel_execution(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> Execution:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")

    if execution.status in (
        ExecutionStatus.COMPLETED,
        ExecutionStatus.FAILED,
        ExecutionStatus.ROLLED_BACK,
    ):
        raise HTTPException(status_code=409, detail="Execution already finished")

    execution.status = ExecutionStatus.FAILED
    execution.error_message = "Cancelled by user"
    execution.completed_at = utcnow()
    execution.lease_expires_at = utcnow()
    await session.commit()
    await session.refresh(execution)
    return execution


@router.get("/{execution_id}/trace", response_model=ExecutionTrace)
async def get_execution_trace(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> ExecutionTrace:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")

    result = await session.execute(
        select(ToolCall)
        .where(ToolCall.execution_id == execution_id)
        .order_by(ToolCall.started_at)
    )
    tool_calls = [ToolCallSummary.model_validate(tc) for tc in result.scalars().all()]
    audit_result = await session.execute(
        select(AuditLog.action).where(AuditLog.resource_id == str(execution_id))
    )
    audit_actions = [row[0] for row in audit_result.all()]
    verify_status = next(
        (a for a in ("verify_unknown", "verify_error") if a in audit_actions), None
    )
    trace_ids = [str(execution_id)]
    if execution.correlation_id:
        trace_ids.append(str(execution.correlation_id))
    span_result = await session.execute(
        select(AuditLog)
        .where(
            AuditLog.resource_id.in_(trace_ids),
            AuditLog.action.like("span:%"),
        )
        .order_by(AuditLog.created_at)
    )
    spans = []
    for audit in span_result.scalars().all():
        details = audit.details or {}
        spans.append(
            SpanSummary(
                span=str(audit.action).removeprefix("span:"),
                status=str(details.get("status") or "ok"),
                latency_ms=details.get("latency_ms"),
                model=details.get("model"),
                tokens=details.get("tokens"),
                cost=details.get("cost"),
                error=details.get("error"),
                recorded_at=audit.created_at.isoformat() if audit.created_at else None,
            )
        )
    plan = execution.plan or {}
    return ExecutionTrace(
        current_step_index=execution.current_step_index,
        status=execution.status,
        tool_calls=tool_calls,
        cost=execution.cost,
        token_usage=execution.token_usage,
        model_used=execution.model_used,
        verify_status=verify_status,
        approval_mismatch_count=audit_actions.count("approval_mismatch"),
        side_effect_proposals=plan.get("side_effect_proposals"),
        spans=spans,
    )


@router.get("/{execution_id}/status", response_model=ExecutionRead)
async def get_execution_status(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> Execution:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")
    return execution


@router.post(
    "/{execution_id}/resume",
    response_model=ExecutionAccepted,
    status_code=202,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("executions:write")),
    ],
)
async def resume_execution(
    execution_id: uuid.UUID,
    payload: ExecutionResume,
    session: SessionDep,
    user: CurrentUserDep,
) -> ExecutionAccepted:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")
    if execution.status != ExecutionStatus.WAITING_FOR_APPROVAL:
        raise HTTPException(
            status_code=409, detail="Execution is not waiting for approval"
        )

    result = await session.execute(
        update(Execution)
        .where(
            Execution.id == execution_id,
            Execution.status == ExecutionStatus.WAITING_FOR_APPROVAL,
        )
        .values(status=ExecutionStatus.RUNNING)
    )
    if result.rowcount:
        await enqueue_outbox_event(
            session,
            "resume_workflow",
            {
                "execution_id": str(execution_id),
                "decision": payload.model_dump(),
            },
            execution_id=execution_id,
        )
    await session.commit()
    if result.rowcount == 0:
        raise HTTPException(
            status_code=409, detail="Execution is already being resumed"
        )

    return ExecutionAccepted(execution_id=execution_id, status=ExecutionStatus.RUNNING)


@router.post(
    "/{execution_id}/feedback",
    response_model=ExecutionRead,
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("executions:write")),
    ],
)
async def submit_feedback(
    execution_id: uuid.UUID,
    payload: FeedbackCreate,
    session: SessionDep,
    user: CurrentUserDep,
) -> Execution:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")

    execution.feedback = payload.feedback
    if payload.rating is not None:
        result = await session.execute(
            select(ExecutionFeedback).where(
                ExecutionFeedback.execution_id == execution_id,
                ExecutionFeedback.user_id == user.id,
            )
        )
        feedback_row = result.scalars().first()
        if feedback_row is None:
            session.add(
                ExecutionFeedback(
                    execution_id=execution_id,
                    user_id=user.id,
                    rating=payload.rating,
                    comment=payload.comment,
                )
            )
        else:
            feedback_row.rating = payload.rating
            feedback_row.comment = payload.comment
    await session.commit()
    await session.refresh(execution)
    return execution


@router.get("/{execution_id}/feedback")
async def list_feedback(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> list[dict]:
    execution = await session.get(Execution, execution_id)
    if execution is None or (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")
    result = await session.execute(
        select(ExecutionFeedback)
        .where(ExecutionFeedback.execution_id == execution_id)
        .order_by(ExecutionFeedback.created_at)
    )
    return [
        {
            "id": str(feedback.id),
            "execution_id": str(feedback.execution_id),
            "user_id": str(feedback.user_id),
            "rating": feedback.rating,
            "comment": feedback.comment,
            "created_at": feedback.created_at,
        }
        for feedback in result.scalars().all()
    ]


@router.post(
    "/{execution_id}/intervene",
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("executions:write")),
    ],
)
async def intervene(
    execution_id: uuid.UUID,
    payload: InterveneRequest,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")

    log = InterventionLog(
        execution_id=execution_id,
        operator=payload.operator,
        action=payload.action,
        modified_plan=payload.modified_plan,
    )
    session.add(log)

    if payload.action == "terminate":
        execution.status = ExecutionStatus.FAILED
        execution.error_message = "终止任务"
        execution.completed_at = utcnow()
    else:
        await enqueue_outbox_event(
            session,
            "resume_workflow",
            {
                "execution_id": str(execution_id),
                "decision": {
                    "approved": True,
                    "comment": payload.modified_plan or "",
                },
            },
            execution_id=execution_id,
        )
    await session.commit()
    return {"status": "ok", "action": payload.action}


@router.get("/{execution_id}/interventions")
async def list_interventions(
    execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> list[dict]:
    execution = await session.get(Execution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if (
        user.organization_id is not None
        and execution.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Execution not found")
    logs = (
        (
            await session.execute(
                select(InterventionLog)
                .where(InterventionLog.execution_id == execution_id)
                .order_by(InterventionLog.created_at)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": str(log.id),
            "operator": log.operator,
            "action": log.action,
            "modified_plan": log.modified_plan,
            "created_at": log.created_at.isoformat(),
        }
        for log in logs
    ]
