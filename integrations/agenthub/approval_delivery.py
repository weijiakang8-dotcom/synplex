"""Frozen, explicit approval for the private engine; no new tool capability.

Preview is read-only. A choice, its immutable identity and outbox commit once.
Lost acknowledgements are inspected, never resent by the workbench. Workers
recheck the exact pending operation before continuing the original graph.
"""
import hashlib
import json
import uuid
from contextvars import ContextVar
from sqlalchemy.orm import noload

_decision_scope = ContextVar("synplex_operation_decision", default=None)


def install_rejection_boundary():
    """A declined operation stops this graph, never advances to another step."""
    from app.engine import graph
    original = graph._waiting_for_approval_node
    if getattr(original, "synplex_rejection_boundary", False):
        return

    async def approval_node(state):
        result = await original(state)
        if _decision_scope.get() == (str(state.get("execution_id")), False):
            return {**result, "approval_rejected": True,
                    "final_output": "你已拒绝本次操作，任务已停止；已有资料和成果保留。需要继续时，请先修改要求，再明确开始。"}
        return result

    approval_node.synplex_rejection_boundary = True
    graph._waiting_for_approval_node = approval_node


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_plan_proposals(proposal):
    from app.engine.canonical import params_canonical
    from app.engine.capabilities import CAPABILITIES
    items = proposal["side_effect_proposals"]
    steps = []
    for item in items:
        capability = CAPABILITIES.get(item.get("capability"))
        if (not capability or item["tool"] not in {tool.name for tool in capability.tools}
                or not isinstance(item.get("step_id"), str) or not item["step_id"]
                or item.get("params_canonical") != params_canonical(item["params"])):
            raise ValueError("Frozen plan proposals are inconsistent")
        steps.append(item["step_id"])
    if len(set(steps)) != len(steps) or set(steps) != set(proposal.get("side_effect_set") or []):
        raise ValueError("Frozen side-effect steps do not match")


def approval_snapshot(execution):
    pending = ((execution.checkpoint_data or {}).get("interrupt") or {})
    if pending.get("type") != "approval_required":
        raise ValueError("Original task is not waiting for an operation")
    proposal = pending.get("tool_call")
    if not isinstance(proposal, dict):
        raise ValueError("Missing frozen operation")
    raw = canonical(proposal)
    if len(raw.encode()) > 32000:
        raise ValueError("Operation preview exceeds the bounded review size")
    digest = hashlib.sha256(raw.encode()).hexdigest()
    identity = str(uuid.uuid5(execution.id, digest))
    if proposal.get("type") == "plan_approval":
        operations = proposal.get("side_effect_proposals")
        if (not isinstance(operations, list) or not 1 <= len(operations) <= 10
                or not isinstance(proposal.get("approval_id"), str) or not proposal["approval_id"]
                or not isinstance(proposal.get("plan_hash"), str) or not proposal["plan_hash"]):
            raise ValueError("Missing frozen plan proposals")
        validate_plan_proposals(proposal)
        operations = [{"tool": p["tool"], "params": p["params"]} for p in operations]
    else:
        uuid.UUID(proposal["tool_call_id"])
        operations = [{"tool": proposal["tool_name"], "params": proposal["tool_args"]}]
    if any(not isinstance(p["tool"], str) or not isinstance(p["params"], dict) for p in operations):
        raise ValueError("Invalid operation parameters")
    return {"protocol": "synplex.operation-approval/1", "executionId": str(execution.id),
            "requestId": identity, "snapshotHash": digest, "operations": operations}


async def validate_pending_tool(session, execution, snapshot):
    from app.engine.tool_registry import get_tool
    from app.engine.canonical import params_canonical, validate_tool_params
    from app.models import ToolCall, User
    from jsonschema import Draft202012Validator
    user = await session.get(User, execution.user_id, options=[noload('*')]) if execution.user_id else None
    if (not user or not user.is_active or user.organization_id != execution.organization_id
            or user.role not in {"admin", "member"}):
        raise ValueError("Original user's permission has changed")
    for operation in snapshot["operations"]:
        spec = get_tool(operation["tool"])
        if (not spec or not (spec.requires_approval or spec.side_effect)
                or spec.organization_id not in (None, str(execution.organization_id))
                or validate_tool_params(operation["tool"], operation["params"])):
            raise ValueError("Operation not available for this project")
        if next(Draft202012Validator(spec.parameters).iter_errors(operation["params"]), None) is not None:
            raise ValueError("Operation parameters do not match their schema")
    pending = execution.checkpoint_data["interrupt"]["tool_call"]
    if pending.get("type") != "plan_approval":
        row = await session.get(ToolCall, uuid.UUID(pending["tool_call_id"]), options=[noload('*')])
        if (not row or row.execution_id != execution.id or row.organization_id != execution.organization_id
                or row.status.value != "pending" or not row.requires_approval
                or row.tool_name != pending["tool_name"]
                or params_canonical(row.input_params) != params_canonical(pending["tool_args"])):
            raise ValueError("Original operation has changed")


def decision_text(snapshot_hash, approved):
    if type(approved) is not bool:
        raise ValueError("Explicit approval choice required")
    return canonical({"snapshotHash": snapshot_hash, "approved": approved})


def install_api(app, data):
    from fastapi import APIRouter, Depends, HTTPException
    from pydantic import BaseModel, ConfigDict, Field
    from app.api.deps import SessionDep, CurrentUserDep, get_current_user
    from app.core.permissions import require_permission
    from app.models import Execution
    from app.models.enums import ExecutionStatus
    from app.engine.outbox import enqueue_outbox_event
    from input_delivery import delivery, insert_intent

    class Choice(BaseModel):
        model_config = ConfigDict(extra="forbid", strict=True)
        requestId: str = Field(pattern=r"^[a-f0-9-]{36}$")
        snapshotHash: str = Field(pattern=r"^[a-f0-9]{64}$")
        approved: bool

    router = APIRouter(dependencies=[Depends(get_current_user)])

    async def own(session, user, eid, lock=False):
        row = await session.get(Execution, eid, with_for_update=lock, options=[noload('*')])
        if (not user.is_active or not row or row.user_id != user.id
                or row.organization_id != user.organization_id
                or str(row.organization_id) != data["organization_id"]
                or str(row.workflow_id) != data["workflow_id"]):
            raise HTTPException(404, "Operation not found")
        return row

    async def snapshot(session, execution):
        try:
            value = approval_snapshot(execution)
            await validate_pending_tool(session, execution, value)
            return value
        except (ValueError, KeyError, TypeError):
            raise HTTPException(409, "Original operation needs reconciliation") from None

    @router.get("/api/synplex/executions/{execution_id}/approval")
    async def preview(execution_id: uuid.UUID, session: SessionDep, user: CurrentUserDep):
        row = await own(session, user, execution_id)
        if row.status != ExecutionStatus.WAITING_FOR_APPROVAL:
            raise HTTPException(409, "Original task is not waiting for approval")
        return await snapshot(session, row)

    @router.post("/api/synplex/executions/{execution_id}/approval", status_code=202,
                 dependencies=[Depends(require_permission("executions:write"))])
    async def choose(execution_id: uuid.UUID, payload: Choice, session: SessionDep, user: CurrentUserDep):
        row = await own(session, user, execution_id, True)
        answer = decision_text(payload.snapshotHash, payload.approved)
        old = await delivery(session, payload.requestId)
        if old:
            if (old["execution_id"] != str(row.id) or old["answer_hash"] != hashlib.sha256(answer.encode()).hexdigest()
                    or old["state"] == "unknown"):
                raise HTTPException(409, "Original decision needs reconciliation")
            return {"requestId": payload.requestId, "executionId": str(row.id), "status": "resuming"}
        if row.status != ExecutionStatus.WAITING_FOR_APPROVAL:
            raise HTTPException(409, "Original task is not waiting for approval")
        current = await snapshot(session, row)
        if current["requestId"] != payload.requestId or current["snapshotHash"] != payload.snapshotHash:
            raise HTTPException(409, "Operation changed; review again")
        await insert_intent(session, payload.requestId, row.id, answer)
        row.status = ExecutionStatus.RUNNING
        await enqueue_outbox_event(session, "resume_workflow", {"execution_id": str(row.id),
            "decision": {"synplexApprovalId": payload.requestId, "snapshotHash": payload.snapshotHash,
                         "approved": payload.approved}}, execution_id=row.id)
        await session.commit()
        return {"requestId": payload.requestId, "executionId": str(row.id), "status": "resuming"}

    @router.get("/api/synplex/executions/{execution_id}/approval-deliveries/{request_id}")
    async def inspect(execution_id: uuid.UUID, request_id: uuid.UUID, session: SessionDep, user: CurrentUserDep):
        await own(session, user, execution_id)
        row = await delivery(session, request_id)
        if not row or row["execution_id"] != str(execution_id):
            raise HTTPException(404, "Decision receipt not found")
        if row["state"] not in {"queued", "running", "finished", "unknown"}:
            raise HTTPException(409, "Decision receipt needs reconciliation")
        return {"protocol": "synplex.operation-decision/1", "executionId": str(execution_id),
                "requestId": str(request_id), "decisionSha256": row["answer_hash"], "deliveryState": row["state"]}

    # Block old decision paths before dispatch on both flat and lazy routers.
    # Nothing is changed in the frozen checkout or any running legacy process.
    from private_routes import ApprovalBoundary
    app.add_middleware(ApprovalBoundary)
    app.include_router(router)


def install_worker():
    from sqlalchemy import text
    from app.database import async_session_factory
    from app.models import Execution
    from app.engine import tasks, runner
    from app.engine.lease_runner import run_with_execution_lease
    from input_delivery import claim_once
    from datetime import datetime, timezone
    install_rejection_boundary()
    original = tasks.resume_workflow_task.run

    async def guarded(eid, choice):
        request_id = choice["synplexApprovalId"]
        serialized = decision_text(choice["snapshotHash"], choice["approved"])
        async with async_session_factory() as session:
            claimed = await claim_once(session, request_id, eid, serialized)
            await session.commit()
        if not claimed:
            return
        state = "unknown"
        try:
            async def resume():
                async with async_session_factory() as session:
                    row = await session.get(Execution, uuid.UUID(eid), options=[noload('*')])
                    current = approval_snapshot(row)
                    if current["requestId"] != request_id or current["snapshotHash"] != choice["snapshotHash"]:
                        raise ValueError("Approved operation changed before execution")
                    await validate_pending_tool(session, row, current)
                token = _decision_scope.set((eid, choice["approved"]))
                try:
                    await runner.resume_execution(uuid.UUID(eid), {"approved": choice["approved"]})
                finally:
                    _decision_scope.reset(token)
            await run_with_execution_lease(uuid.UUID(eid), "synplex-approval:" + request_id, resume)
            state = "finished"
        finally:
            async with async_session_factory() as session:
                await session.execute(text("""UPDATE synplex_input_deliveries SET state=:state,finished_at=:time
                    WHERE question_id=:id AND state='running'"""), {"id": request_id, "state": state,
                    "time": datetime.now(timezone.utc).isoformat()})
                await session.commit()

    def run(execution_id, decision):
        if "synplexApprovalId" not in decision:
            return original(execution_id, decision)
        return tasks.run_worker_async(guarded(execution_id, decision))
    tasks.resume_workflow_task.run = run
