"""Free real PostgreSQL/API/checkpoint/worker approval protocol check.

No model, external HTTP, broker publication or real email. The only tool is a
clearly registered fixture which writes an effect row inside this private DB.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import TypedDict
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from private_infrastructure import OwnedInfrastructure, prepare, read_private, write_private, safe_env
spec = importlib.util.spec_from_file_location("graph_check_helpers", Path(__file__).with_name("full-graph-check.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


class State(TypedDict, total=False):
    execution_id: str
    organization_id: str
    user_id: str
    pending_approval: dict
    current_step: int
    plan: list
    final_output: str
    approval_rejected: bool


def fixture_graph(*, checkpointer, dag=None):
    from langgraph.graph import StateGraph, START, END
    from app.engine.graph import _waiting_for_approval_node, _route_step
    async def following(state):
        from app.database import async_session_factory
        from sqlalchemy import text
        async with async_session_factory() as session:
            await session.execute(text("INSERT INTO synplex_approval_fixture_following(marker) VALUES (:marker)"),
                                  {"marker": state["execution_id"]})
            await session.commit()
        return {}
    graph = StateGraph(State)
    graph.add_node("approval", _waiting_for_approval_node)
    graph.add_node("general", following)
    graph.add_edge(START, "approval")
    graph.add_conditional_edges("approval", _route_step, {"general": "general", END: END})
    graph.add_edge("general", END)
    return graph.compile(checkpointer=checkpointer)


def forbid_external():
    import httpx
    original = httpx.AsyncClient.send
    async def only_asgi(client, request, *args, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport):
            raise AssertionError("Only in-process ASGI allowed")
        return await original(client, request, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("Model/external/broker call forbidden")
    httpx.AsyncClient.send, httpx.Client.send = only_asgi, forbidden
    from kombu.messaging import Producer
    Producer.publish = forbidden
    from app.core.model_gateway import ModelGateway
    ModelGateway.invoke = forbidden
    ModelGateway.stream = forbidden


def install_fixtures():
    from sqlalchemy import text
    from app.database import async_session_factory
    from app.engine import runner, event_bus, tool_executor, tasks
    from app.engine.tool_registry import register_tool
    async def effect(params, organization_id):
        async with async_session_factory() as session:
            await session.execute(text("INSERT INTO synplex_approval_fixture_effects(marker) VALUES (:marker)"), {"marker": params["to"]})
            await session.commit()
        return {"status": "success", "data": {"fixtureOnly": True}, "error": None}
    async def event(*args, **kwargs):
        pass  # Event transport is explicitly not part of this scenario.
    # Import original graph before registration so builtin setup cannot replace
    # this private no-network fixture with a real email handler.
    from app.engine.graph import _waiting_for_approval_node
    register_tool("send_email", "隔离夹具：只记录一次允许操作，不发送邮件", {
        "type": "object", "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
        "required": ["to", "subject", "body"], "additionalProperties": False,
    }, effect, requires_approval=True, side_effect=True)
    runner.build_graph = fixture_graph
    event_bus.publish_execution_event = event
    runner.publish_execution_event = event
    tool_executor.publish_execution_event = event
    runner.evaluate_execution_task.delay = lambda *args: None
    from input_delivery import install_worker
    from approval_delivery import install_worker as install_approval_worker
    install_worker()
    install_approval_worker()
    return tasks


async def seed_and_api(evidence):
    import httpx
    from fastapi import FastAPI
    from sqlalchemy import text, select, func
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
    from app.database import master_engine
    from app.models import Base, Organization, User, Workflow, Execution, ToolCall, OutboxEvent
    from app.models.enums import ExecutionStatus, ToolCallStatus
    from app.api.deps import get_current_user
    from app.database import get_db
    from app.engine.checkpoint import get_checkpoint_manager
    from input_delivery import initialize, delivery
    from approval_delivery import install_api, approval_snapshot
    fault = {"commit": False}
    class Session(AsyncSession):
        async def commit(self):
            if fault["commit"]:
                fault["commit"] = False
                raise RuntimeError("Fixture failure before atomic commit")
            return await super().commit()
    sessions = async_sessionmaker(master_engine, class_=Session, expire_on_commit=False)
    async with master_engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION vector"))
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(text("CREATE TABLE synplex_approval_fixture_effects(marker TEXT NOT NULL)"))
        await connection.execute(text("CREATE TABLE synplex_approval_fixture_following(marker TEXT NOT NULL)"))
    await initialize(master_engine)
    org, uid, wid = (uuid.uuid4() for _ in range(3))
    data = {"organization_id": str(org), "workflow_id": str(wid)}
    items = []
    async with sessions() as session:
        session.add(Organization(id=org, name="免费审批协议夹具", slug="approval-" + org.hex))
        await session.flush()
        user = User(id=uid, organization_id=org, email="approval@synplex.invalid", password_hash="disabled", role="admin", is_active=True)
        session.add(user)
        session.add(Workflow(id=wid, organization_id=org, name="审批协议", created_by=str(uid)))
        await session.flush()
        for mode in ("allow", "reject", "changed_after_choice", "revoked_after_choice"):
            eid, tool_id = uuid.uuid4(), uuid.uuid4()
            params = {"to": str(eid) + "@synplex.invalid", "subject": "仅隔离夹具", "body": "固定内容"}
            pending = {"tool_call_id": str(tool_id), "tool_name": "send_email", "tool_args": params}
            session.add(Execution(id=eid, workflow_id=wid, organization_id=org, user_id=uid,
                user_input="只验证操作审批协议", status=ExecutionStatus.WAITING_FOR_APPROVAL,
                current_step_index=0, checkpoint_data={"interrupt": {"type": "approval_required", "tool_call": pending}}))
            await session.flush()
            session.add(ToolCall(id=tool_id, execution_id=eid, organization_id=org, tool_name="send_email", input_params=params,
                requires_approval=True, status=ToolCallStatus.PENDING, idempotency_key=uuid.uuid4().hex))
            items.append({"mode": mode, "executionId": str(eid), "toolCallId": str(tool_id), "pending": pending})
        await session.commit()
    async with get_checkpoint_manager() as manager:
        graph = fixture_graph(checkpointer=manager.saver)
        for item in items:
            state = {"execution_id": item["executionId"], "organization_id": str(org), "user_id": str(uid),
                     "pending_approval": item["pending"], "current_step": 0,
                     "plan": [{"capability": "general"}, {"capability": "general"}]}
            observed = await graph.ainvoke(state, {"configurable": {"thread_id": item["executionId"]}})
            assert observed["__interrupt__"]
    app = FastAPI()
    install_api(app, data)
    identity = type("Identity", (), {"id": uid, "organization_id": org, "role": "admin", "is_active": True})()
    app.dependency_overrides[get_current_user] = lambda: identity
    async def database():
        async with sessions() as session:
            yield session
    app.dependency_overrides[get_db] = database
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://fixture") as client:
        for item in items:
            route = "/api/synplex/executions/" + item["executionId"] + "/approval"
            preview = await client.get(route)
            assert preview.status_code == 200, preview.text
            snapshot = preview.json()
            choice = {"requestId": snapshot["requestId"], "snapshotHash": snapshot["snapshotHash"], "approved": item["mode"] != "reject"}
            item["choice"] = choice
            if item["mode"] == "allow":
                identity.id = uuid.uuid4()
                assert (await client.get(route)).status_code == 404
                identity.id, identity.organization_id = uid, uuid.uuid4()
                assert (await client.get(route)).status_code == 404
                identity.organization_id, identity.role = org, "viewer"
                assert (await client.post(route, json=choice)).status_code == 403
                identity.role = "admin"
                assert (await client.post(route, json={**choice, "snapshotHash": "0" * 64})).status_code == 409
                assert (await client.post(route, json={**choice, "approved": "true"})).status_code == 422
                fault["commit"] = True
                assert (await client.post(route, json=choice)).status_code == 500
                async with sessions() as session:
                    assert await delivery(session, choice["requestId"]) is None
                    assert await session.scalar(select(func.count()).select_from(OutboxEvent)) == 0
                    assert (await session.get(Execution, uuid.UUID(item["executionId"]))).status == ExecutionStatus.WAITING_FOR_APPROVAL
            accepted = await client.post(route, json=choice)
            assert accepted.status_code == 202, accepted.text
            assert (await client.post(route, json=choice)).status_code == 202
            assert (await client.post(route, json={**choice, "approved": not choice["approved"]})).status_code == 409
            receipt = await client.get(route.replace("/approval", "/approval-deliveries/") + choice["requestId"])
            assert receipt.status_code == 200 and receipt.json()["deliveryState"] == "queued"
            if item["mode"] == "changed_after_choice":
                async with sessions() as session:
                    tool = await session.get(ToolCall, uuid.UUID(item["toolCallId"]))
                    tool.input_params = {**tool.input_params, "body": "在确认后被改变的内容"}
                    await session.commit()
    async with sessions() as session:
        outbox = list((await session.execute(select(OutboxEvent))).scalars())
        assert len(outbox) == len(items)
        assert await session.scalar(select(func.count()).select_from(ToolCall).where(ToolCall.status != ToolCallStatus.PENDING)) == 0
    # Plan review projection uses the original frozen proposal contract. This
    # checks only the proposal boundary, not another model/plan execution.
    from types import SimpleNamespace
    from app.engine.canonical import params_canonical
    plan = {"type": "plan_approval", "approval_id": uuid.uuid4().hex, "plan_hash": "b" * 64,
            "side_effect_set": ["send"], "side_effect_proposals": [{"step_id": "send", "capability": "send_email",
            "tool": "send_email", "params": params, "params_canonical": params_canonical(params)}]}
    candidate = SimpleNamespace(id=uuid.uuid4(), checkpoint_data={"interrupt": {"type": "approval_required", "tool_call": plan}})
    assert approval_snapshot(candidate)["operations"] == [{"tool": "send_email", "params": params}]
    plan["side_effect_proposals"][0]["params_canonical"] = "changed"
    try:
        approval_snapshot(candidate)
    except ValueError:
        pass
    else:
        raise AssertionError("Inconsistent frozen plan proposal was accepted")
    write_private(evidence / "intent.json", {"data": data, "userId": str(uid), "items": items, "modelCalls": 0})
    await master_engine.dispose()


def consume(evidence):
    from app.engine import tasks
    saved = read_private(evidence / "intent.json")
    for item in saved["items"]:
        choice = item["choice"]
        decision = {"synplexApprovalId": choice["requestId"], "snapshotHash": choice["snapshotHash"], "approved": choice["approved"]}
        revoked = item["mode"] == "revoked_after_choice"
        if revoked:
            tasks.run_worker_async(user_active(saved, False))
        if item["mode"] in {"changed_after_choice", "revoked_after_choice"}:
            try:
                tasks.resume_workflow_task.run(item["executionId"], decision)
            except ValueError:
                pass
            else:
                raise AssertionError("Changed tool parameters were not refused")
        else:
            tasks.resume_workflow_task.run(item["executionId"], decision)
        tasks.resume_workflow_task.run(item["executionId"], decision)  # Duplicate message must not repeat graph/tool.
        if revoked:
            tasks.run_worker_async(user_active(saved, True))
    tasks.run_worker_async(verify(evidence))
    tasks.close_worker_loop()


async def user_active(saved, active):
    from app.models import User
    from app.database import async_session_factory
    async with async_session_factory() as session:
        user = await session.get(User, uuid.UUID(saved["userId"]))
        user.is_active = active
        await session.commit()


async def verify(evidence):
    from sqlalchemy import text, select, func
    from app.database import master_engine, replica_engine, async_session_factory
    from app.models import ToolCall, OutboxEvent, UsageEvent, Execution
    from input_delivery import delivery
    saved = read_private(evidence / "intent.json")
    observed = []
    async with async_session_factory() as session:
        effects = (await session.execute(text("SELECT marker FROM synplex_approval_fixture_effects"))).scalars().all()
        assert len(effects) == 1 and effects[0].startswith(saved["items"][0]["executionId"])
        following = (await session.execute(text("SELECT marker FROM synplex_approval_fixture_following"))).scalars().all()
        assert following == [saved["items"][0]["executionId"]], "Rejected operation must stop before the following step"
        for item in saved["items"]:
            tool = await session.get(ToolCall, uuid.UUID(item["toolCallId"]))
            row = await delivery(session, item["choice"]["requestId"])
            expected = {"allow": ("success", "finished"), "reject": ("rejected", "finished"), "changed_after_choice": ("pending", "unknown"), "revoked_after_choice": ("pending", "unknown")}[item["mode"]]
            assert (tool.status.value, row["state"]) == expected
            execution = await session.get(Execution, uuid.UUID(item["executionId"]))
            if item["mode"] == "reject":
                assert execution.status.value == "failed" and execution.error_message == "approval_rejected"
                assert "拒绝" in execution.final_output
            observed.append({"mode": item["mode"], "toolStatus": tool.status.value, "deliveryState": row["state"],
                             "executionStatus": execution.status.value})
        assert await session.scalar(select(func.count()).select_from(OutboxEvent)) == 4
        assert await session.scalar(select(func.count()).select_from(UsageEvent)) == 0
    write_private(evidence / "result.json", {"status": "passed", "modelCalls": 0, "effects": len(effects), "observed": observed,
        "atomicDecisionAndOutbox": True, "crossOwnerAndOrganizationRefused": True, "viewerCannotChoose": True,
        "permissionRevokedAfterChoiceRefused": True, "planProposalConsistencyChecked": True,
        "duplicateWorkerMessagesHaveNoExtraEffect": True, "realCheckpointAndApprovalNode": True,
        "rejectionStopsFollowingSteps": True, "rejectionIsNotSuccess": True,
        "brokerTransport": "not exercised", "realProvider": False, "tool": "no-network private effect fixture"})
    await master_engine.dispose()
    await replica_engine.dispose()


async def audit_routes(evidence):
    import httpx
    from fastapi import FastAPI
    from app.api.deps import get_current_user
    from app.api.routes.executions import router as execution_router
    from app.api.routes.tool_calls import router as tool_router
    from app.database import master_engine, replica_engine, async_session_factory
    from app.models import Execution, ToolCall, OutboxEvent, UsageEvent
    from sqlalchemy import select, func
    from approval_delivery import install_api
    saved = read_private(evidence / "intent.json")
    app = FastAPI()
    app.include_router(execution_router, prefix="/api")
    app.include_router(tool_router, prefix="/api")
    install_api(app, saved["data"])
    identity = type("Identity", (), {"id": uuid.UUID(saved["userId"]), "organization_id": uuid.UUID(saved["data"]["organization_id"]), "role": "admin", "is_active": True})()
    app.dependency_overrides[get_current_user] = lambda: identity
    async def counts():
        async with async_session_factory() as session:
            return [await session.scalar(select(func.count()).select_from(model)) for model in (Execution, ToolCall, OutboxEvent, UsageEvent)]
    before = await counts()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
        item = saved["items"][0]
        for route in ("executions/" + item["executionId"] + "/resume", "executions/" + item["executionId"] + "/intervene",
                      "tool_calls/" + item["toolCallId"] + "/approve", "tool_calls/" + item["toolCallId"] + "/reject"):
            assert (await client.post("/api/" + route, json={"approved": True})).status_code in {404, 405}
        for item in saved["items"]:
            response = await client.get("/api/synplex/executions/" + item["executionId"] + "/approval-deliveries/" + item["choice"]["requestId"])
            assert response.status_code == 200
            assert response.json()["deliveryState"] == ("unknown" if item["mode"].endswith("choice") else "finished")
    assert await counts() == before
    write_private(evidence / "route-audit.json", {"status": "passed", "legacyBypassRoutesBlocked": 4,
        "savedDecisionsReadableWithoutRedispatch": True, "beforeCounts": before, "afterCounts": await counts(), "modelCalls": 0})
    await master_engine.dispose()
    await replica_engine.dispose()


def run(backend, evidence, pg_bin):
    if evidence.exists():
        raise RuntimeError("Evidence exists; inspect original outcomes, never overwrite")
    infrastructure = prepare(evidence, pg_bin, port=helpers.port())
    queue = evidence / "queue"
    queue.mkdir(mode=0o700)
    write_private(queue / "bootstrap.json", {"redis_port": 1, "redis_password": "disabled-fixture"})
    owned = OwnedInfrastructure(infrastructure)
    try:
        owned.start_database()
        for phase in ("seed", "consume", "routes"):
            with open(evidence / (phase + ".log"), "xb") as log:
                os.chmod(log.name, 0o600)
                process = subprocess.run([sys.executable, "-B", __file__, "--" + phase, str(backend), str(evidence)],
                    env=safe_env(), stdout=log, stderr=log, cwd=evidence, timeout=90)
            if process.returncode:
                raise RuntimeError("Approval phase failed; inspect its preserved " + phase + ".log")
    finally:
        owned.close()


if __name__ == "__main__":
    if sys.argv[1] in {"--seed", "--consume", "--routes"}:
        helpers.configure(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
        forbid_external()
        install_fixtures()
        if sys.argv[1] == "--seed":
            asyncio.run(seed_and_api(Path(sys.argv[3]).resolve()))
        elif sys.argv[1] == "--consume":
            consume(Path(sys.argv[3]).resolve())
        else:
            asyncio.run(audit_routes(Path(sys.argv[3]).resolve()))
    else:
        run(*(Path(argument).absolute() for argument in sys.argv[1:]))
