"""Free whole-graph check, with real engine and deterministic provider HTTP.

Usage: private-python -B full-graph-check.py BACKEND NEW_EVIDENCE PG_BIN VALKEY
No real provider/host, external HTTP, shared database or broker dispatch allowed.
Synthetic provider tokens and PASS are fixtures, not business quality evidence.
"""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from private_infrastructure import OwnedInfrastructure, prepare, read_private, safe_env, write_private


def port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def configure(backend, evidence):
    from sqlalchemy.engine import URL
    infra = read_private(evidence / "infrastructure.json")
    queue = read_private(evidence / "queue/bootstrap.json")
    sys.path.insert(0, str(backend))
    from app import config
    defaults = {key: field.get_default(call_default_factory=True) for key, field in config.Settings.model_fields.items()}
    defaults.update(DATABASE_URL=URL.create("postgresql+asyncpg", username=infra["username"], password=infra["password"],
                    host="127.0.0.1", port=infra["port"], database="postgres").render_as_string(hide_password=False),
                    REPLICA_DATABASE_URL="", REDIS_URL=f'redis://:{queue["redis_password"]}@127.0.0.1:{queue["redis_port"]}/0',
                    OPENAI_API_KEY="", OPENAI_FALLBACK_ENABLED=False, MCP_CONNECTORS_JSON="[]",
                    SYNPLEX_CONNECTIONS_FILE="", SYNPLEX_EXTENSION_ROOT="", OTEL_SDK_DISABLED=True,
                    SHADOW_MODE=False, REAL_EFFECT_MODE=False, GENERAL_EXECUTOR_ENABLED=True,
                    ARTIFACT_ROOT=str(evidence / "artifacts"), CONTEXT_SUMMARY_MAX_CALLS=1,
                    TENANT_MAX_CONCURRENT_LLM_CALLS=1, TENANT_MONTHLY_TOKEN_BUDGET=200000,
                    TENANT_MONTHLY_COST_BUDGET_CNY=1.0)
    config.settings = config.Settings(_env_file=None, **defaults)


async def scenario(evidence):
    import httpx
    from fastapi import FastAPI
    from langchain_openai import ChatOpenAI
    from sqlalchemy import select, text
    from app.database import master_engine, replica_engine, async_session_factory
    from app.models import Base, Organization, User, Workflow, ModelConfig, Execution, ToolCall, UsageEvent, OutboxEvent
    from app.models.enums import WorkflowStatus, ExecutionStatus
    from app.models.artifact import Artifact
    from app.api.deps import get_current_user
    from app.api.routes.artifacts import router as artifact_router
    from app.core import model_gateway
    from app.engine import event_bus
    from task_tools import install
    from task_files import initialize, inventory
    from model_binding import install_api, install_runtime

    # Every HTTP request is in-process ASGI or our exact provider fixture.
    original_send = httpx.AsyncClient.send
    async def guarded_send(client, request, *args, **kwargs):
        if not isinstance(client._transport, (httpx.ASGITransport, httpx.MockTransport)):
            raise AssertionError("External HTTP forbidden")
        return await original_send(client, request, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("External HTTP or broker publishing forbidden")
    httpx.AsyncClient.send, httpx.Client.send = guarded_send, forbidden
    from kombu.messaging import Producer
    Producer.publish = forbidden
    events, evaluations = [], []
    async def local_event(execution_id, payload):
        events.append({"executionId": execution_id, **payload})
    event_bus.publish_execution_event = local_event
    from app.engine import runner
    runner.evaluate_execution_task.delay = lambda eid: evaluations.append(eid)
    install()
    async with master_engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION vector"))
        await connection.execute(text('CREATE EXTENSION "uuid-ossp"'))
        await connection.run_sync(Base.metadata.create_all)
    await initialize(master_engine)
    org, uid, wid = (uuid.uuid4() for _ in range(3))
    data = {"organization_id": str(org), "workflow_id": str(wid)}
    async with async_session_factory() as session:
        session.add(Organization(id=org, name="全图免费夹具", slug="graph-" + org.hex))
        await session.flush()
        session.add(User(id=uid, organization_id=org, email="graph@synplex.invalid", password_hash="disabled"))
        session.add(Workflow(id=wid, organization_id=org, name="完整目标", created_by=str(uid),
                             agent_chain=[], status=WorkflowStatus.ACTIVE))
        session.add(ModelConfig(organization_id=org, name="Fixture only", provider="deepseek", model="deepseek-flash",
                    api_key="synplex-runtime-keychain", base_url="https://api.deepseek.com/v1", max_tokens=2400,
                    timeout=10, max_retries=0, config={"pricingStatus": "unknown", "reasoning_effort": "low",
                    "capabilities": {"context_window": 1000000, "tool_calling": True, "structured_output": True}}))
        await session.commit()
    raw = "分类,收入\n房费,0.1\n房费,0.2\n餐费,1.25\n".encode()
    source = {"sourceId": "graph-original", "occurrenceId": "graph-source-event", "name": "收入明细.csv",
              "sha256": hashlib.sha256(raw).hexdigest(), "byteLength": len(raw), "mediaType": "text/csv",
              "contentBase64": base64.b64encode(raw).decode()}
    file_key = inventory([source])[0]["file_key"]
    goal = "按分类统计上传收入，保留原文件依据，把合计、口径及原件指纹写入可下载的Markdown报告。"
    plan = {"goal": goal, "risk": "LOW", "feasibility": {"possible": True, "missing": [], "continue_with": []},
            "deliverables": [{"type": "artifact", "what": "收入统计报告", "done_when": "真实文件可下载且与计算结果一致"}],
            "steps": [{"step_id": "calculate", "capability": "general", "description": "读取原表并计算，产出完整报告正文",
                       "input_refs": ["user_input"], "output_name": "manuscript", "required_tools": ["read_task_file", "summarize_table"]},
                      {"step_id": "publish", "capability": "document", "description": "完整正文保存为Markdown",
                       "input_refs": ["manuscript"], "depends_on": ["calculate"], "output_name": "report",
                       "artifact_formats": ["md"], "document_title": "收入统计报告"}]}
    requests, draft = [], None
    def response(request):
        nonlocal draft
        assert request.url.host == "fixture.invalid" and request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-flash" and body["reasoning_effort"] == "high"
        index = len(requests)
        messages = body["messages"]
        tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
        requests.append({"index": index, "model": body["model"], "effort": body["reasoning_effort"], "tools": tool_names})
        message = {"role": "assistant", "content": ""}
        if index == 0:
            assert goal in json.dumps(messages, ensure_ascii=False) and file_key in json.dumps(messages)
            assert "粗粒度子目标" in str(messages[1 if "信任" in str(messages[0]) else 0:])
            message["content"] = json.dumps(plan, ensure_ascii=False)
        elif index in (1, 2):
            name = "read_task_file" if index == 1 else "summarize_table"
            assert name in tool_names
            if index == 2:
                read = json.loads(next(m["content"] for m in reversed(messages) if m["role"] == "tool"))
                assert read["status"] == "success" and read["data"]["text"] == raw.decode()
                assert read["data"]["sha256"] == source["sha256"]
            params = {"file_key": file_key}
            if index == 2:
                params.update(operation="sum", value_column="收入", group_column="分类", title="收入统计")
            message["tool_calls"] = [{"id": "fixture-" + str(index), "type": "function",
                "function": {"name": name, "arguments": json.dumps(params, ensure_ascii=False)}}]
        elif index == 3:
            result = json.loads(next(m["content"] for m in reversed(messages) if m["role"] == "tool"))
            assert result["status"] == "success", result
            calculation = result["data"]["calculation"]
            assert calculation["preview"] == [["房费", "0.3", "2"], ["餐费", "1.25", "1"]]
            assert calculation["sourceSha256"] == source["sha256"]
            draft = "# 收入统计报告\n\n" + "\n".join(f"{row[0]}：{row[1]}（{row[2]}行）" for row in calculation["preview"])
            draft += "\n\n口径：按分类精确十进制求和，无空值或公式。\n原件SHA256：" + source["sha256"]
            message["content"] = draft
        elif index == 4:
            assert "PASS或FAIL" in str(messages) and "收入统计报告.md" in str(messages)
            message["content"] = "PASS"  # Fixture verdict only, not a model quality claim.
        else:
            raise AssertionError("Unplanned provider request, including repair/summarization")
        return httpx.Response(200, json={"id": "fixture-" + str(index), "object": "chat.completion", "created": 1,
            "model": body["model"], "choices": [{"index": 0, "message": message,
            "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}],
            "usage": {"prompt_tokens": 17, "completion_tokens": 9, "total_tokens": 26}})
    provider = httpx.AsyncClient(transport=httpx.MockTransport(response))
    def client(model, *, reasoning_effort=None):
        return ChatOpenAI(model=model.model, api_key="fixture-not-a-credential", base_url="https://fixture.invalid/v1",
            reasoning_effort=reasoning_effort, max_tokens=2400, max_retries=0, http_async_client=provider,
            metadata={"synplex_context_window": 1000000})
    model_gateway.get_chat_model = client
    async def unknown_rate(self, name, organization_id):
        return None  # Same cold-start policy as clean product installations.
    model_gateway.ModelGateway._rate_for_model = unknown_rate
    install_runtime(data)
    app = FastAPI()
    install_api(app, data)
    app.include_router(artifact_router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: type("UserIdentity", (), {"id": uid, "organization_id": org})()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as api:
            accepted = await api.post("/api/synplex/executions", json={"workflow_id": str(wid), "user_input": goal,
                "model_selection": {"provider": "deepseek", "model": "deepseek-flash", "reasoning_effort": "high"}, "input_files": [source]})
            assert accepted.status_code == 202, accepted.text
            eid = uuid.UUID(accepted.json()["execution_id"])
            write_private(evidence / "execution-intent.json", {"executionId": str(eid), "originalSha256": source["sha256"], "modelCalls": 0})
            await runner.run_execution(eid)
            async with async_session_factory() as session:
                execution = await session.get(Execution, eid)
                snapshot = execution.checkpoint_data or {}
                write_private(evidence / "execution-observed.json", {"status": execution.status.value,
                    "error": execution.error_message, "snapshot": snapshot, "requests": requests})
                assert execution.status == ExecutionStatus.COMPLETED, execution.error_message
                assert execution.plan["steps"][1]["depends_on"] == ["calculate"]
                assert snapshot["delivery"]["status"] == "completed", snapshot["delivery"]
                artifacts = list((await session.execute(select(Artifact).where(Artifact.execution_id == eid))).scalars())
                calls = list((await session.execute(select(ToolCall).where(ToolCall.execution_id == eid))).scalars())
                usages = list((await session.execute(select(UsageEvent).where(UsageEvent.execution_id == eid))).scalars())
                assert sorted(a.format for a in artifacts) == ["csv", "md"]
                assert sorted(c.tool_name for c in calls) == ["export_document", "read_task_file", "summarize_table"]
                assert len(usages) == len(requests) == 5 and all(row.cost is None for row in usages)
                assert execution.cost is None, "Unknown configured prices cannot become zero execution cost"
                assert len((await session.execute(select(OutboxEvent))).scalars().all()) == 1
                for artifact in artifacts:
                    download = await api.get(f"/api/artifacts/{artifact.id}/download")
                    assert download.status_code == 200 and hashlib.sha256(download.content).hexdigest() == artifact.sha256
                    if artifact.format == "md":
                        assert download.content == draft.encode()
                    else:
                        assert "房费,0.3,2" in download.text and "餐费,1.25,1" in download.text
                # Terminal guard must not repeat planning, tools, usage or files.
                await runner.run_execution(eid)
                assert len(requests) == 5 and evaluations == [str(eid)]
                observed = await api.get(f"/api/synplex/executions/{eid}/usage")
                assert observed.status_code == 200, observed.text
                receipt = observed.json()
                assert receipt["recordedCalls"] == 5 and receipt["inputTokens"] == 85 and receipt["outputTokens"] == 45
                assert receipt["provenance"] == "provider_receipt" and receipt["coverage"] == "completed_recorded_calls"
                assert receipt["paidUsd"] is None
                assert (await api.get(f"/api/synplex/executions/{uuid.uuid4()}/usage")).status_code == 404
                from app.core.billing import record_execution_usage
                # Re-aggregation of the same frozen receipts must preserve null.
                await record_execution_usage(eid)
                usages[0].status = "estimated"
                await session.commit()
                estimated = (await api.get(f"/api/synplex/executions/{eid}/usage")).json()
                assert estimated["provenance"] == "estimate" and estimated["paidUsd"] is None
                usages[0].status = "partial_estimate"
                await session.commit()
                assert (await api.get(f"/api/synplex/executions/{eid}/usage")).json()["coverage"] == "partial_or_unknown"
                usages[0].status = "success"
                await session.commit()
                write_private(evidence / "result.json", {"status": "passed", "executionId": str(eid),
                    "paidModelCalls": 0, "fixtureProviderResponses": len(requests), "syntheticTokens": True,
                    "realGraph": True, "realGateway": True, "realWorkerBroker": False,
                    "realModelQualityVerified": False, "eventTransport": "in-process fixture",
                    "artifactFormats": sorted(a.format for a in artifacts), "toolCalls": [c.tool_name for c in calls],
                    "executionCost": execution.cost, "usageCosts": [row.cost for row in usages],
                    "usageReceipt": receipt, "estimatedAndInterruptedReceiptsChecked": True,
                    "verification": "deterministic PASS fixture", "originalSha256": source["sha256"]})
            assert model_gateway.get_active_selection() is None
        print(json.dumps({"status": "passed", "paidModelCalls": 0, "fixtureResponses": len(requests)}))
    finally:
        await provider.aclose()
        await master_engine.dispose()
        await replica_engine.dispose()


def run(backend, evidence, pg_bin, valkey):
    if evidence.exists():
        raise RuntimeError("Evidence already exists; inspect actual execution before continuing")
    infra = prepare(evidence, pg_bin, port=port())
    queue = evidence / "queue"
    queue.mkdir(mode=0o700)
    identity = {"infrastructure_id": infra["id"], "redis_port": port(), "redis_password": secrets.token_hex(32)}
    write_private(queue / "bootstrap.json", identity)
    config = f'bind 127.0.0.1\nport {identity["redis_port"]}\nrequirepass {identity["redis_password"]}\ndir "{queue}"\nsave ""\nappendonly no\n'
    with os.fdopen(os.open(queue / "valkey.conf", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(config)
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        owned.start_queue(valkey, queue)
        with open(evidence / "scenario.log", "xb") as log:
            os.chmod(log.name, 0o600)
            result = subprocess.run([sys.executable, "-B", __file__, "--child", str(backend), str(evidence)],
                env=safe_env(), cwd=evidence, stdout=log, stderr=log, timeout=120)
        write_private(evidence / "process-result.json", {"exitCode": result.returncode, "paidModelCalls": 0})
        if result.returncode:
            raise RuntimeError("Full-graph check failed; inspect its private scenario log and observed result")
    finally:
        owned.close()


async def recheck_usage(evidence):
    """Re-use the finished private task; no planning, tool or model replay."""
    import httpx
    from fastapi import FastAPI
    from sqlalchemy import select, text, func
    from app.database import master_engine, replica_engine, async_session_factory
    from app.models import Execution, User, ToolCall, UsageEvent, AuditLog
    from app.models.artifact import Artifact
    from app.api.deps import get_current_user
    from usage_evidence import install_runtime, install_api
    from app.core import billing
    result = read_private(evidence / "result.json")
    assert result["status"] == "passed" and result["paidModelCalls"] == 0
    eid = uuid.UUID(result["executionId"])
    install_runtime()
    async def counts():
        async with async_session_factory() as session:
            return [await session.scalar(select(func.count()).select_from(model)) for model in (Execution, ToolCall, Artifact, UsageEvent)]
    before = await counts()
    async with async_session_factory() as session:
        task = await session.get(Execution, eid)
        assert task.cost is None and task.status.value == "completed"
        user = await session.get(User, task.user_id)
        # Any transient legacy zero commit would fail this actual DB constraint.
        await session.execute(text('ALTER TABLE executions ADD CONSTRAINT fixture_unknown_cost CHECK (cost IS NULL)'))
        await session.commit()
    try:
        await billing.record_execution_usage(eid)
        app = FastAPI()
        install_api(app, {"organization_id": str(user.organization_id), "workflow_id": str(task.workflow_id)})
        identity = type("Identity", (), {"id": user.id, "organization_id": user.organization_id})()
        app.dependency_overrides[get_current_user] = lambda: identity
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as api:
            route = f"/api/synplex/executions/{eid}/usage"
            assert (await api.get(route)).json()["provenance"] == "provider_receipt"
            identity.id = uuid.uuid4()
            assert (await api.get(route)).status_code == 404
            identity.id, identity.organization_id = user.id, uuid.uuid4()
            assert (await api.get(route)).status_code == 404
            identity.organization_id = user.organization_id
            async with async_session_factory() as session:
                row = AuditLog(method="TRACE", path="/fixture", status_code=0, action="span:llm", resource_type="trace",
                    resource_id=str(eid), details={"status": "error"})
                session.add(row)
                await session.commit()
                try:
                    assert (await api.get(route)).json()["coverage"] == "partial_or_unknown"
                finally:
                    await session.delete(row)
                    await session.commit()
        assert await counts() == before
        write_private(evidence / "usage-recheck.json", {"status": "passed", "sameExecution": str(eid),
            "beforeCounts": before, "afterCounts": await counts(), "noTransientZero": True,
            "foreignUserAndOrganizationDenied": True, "failureSpanPreventsCompleteCoverage": True, "paidModelCalls": 0})
    finally:
        async with master_engine.begin() as connection:
            await connection.execute(text('ALTER TABLE executions DROP CONSTRAINT fixture_unknown_cost'))
        await master_engine.dispose()
        await replica_engine.dispose()


if __name__ == "__main__":
    if sys.argv[1] in {"--child", "--usage-child"}:
        configure(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
        entry = scenario if sys.argv[1] == "--child" else recheck_usage
        asyncio.run(entry(Path(sys.argv[3]).resolve()))
    elif sys.argv[1] == "--recheck-usage":
        backend, evidence = (Path(value).absolute() for value in sys.argv[2:])
        if (evidence / "usage-recheck.log").exists() or (evidence / "usage-recheck.json").exists():
            raise RuntimeError("Usage check already attempted; inspect its outcome before continuing")
        owned = OwnedInfrastructure(read_private(evidence / "infrastructure.json"))
        try:
            owned.start_database()
            with open(evidence / "usage-recheck.log", "xb") as log:
                os.chmod(log.name, 0o600)
                process = subprocess.run([sys.executable, "-B", __file__, "--usage-child", str(backend), str(evidence)],
                    env=safe_env(), stdout=log, stderr=log, timeout=30)
            if process.returncode:
                raise RuntimeError("Usage recheck failed; inspect its original log, do not repeat the task")
        finally:
            owned.close()
    else:
        run(*(Path(argument).absolute() for argument in sys.argv[1:]))
