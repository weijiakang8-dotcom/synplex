"""Free core check: durable question -> API answer -> actual worker/runner entry.

Only graph nodes and event transport are deterministic fixtures. PostgreSQL,
checkpoint manager, answer route, intent guard, execution lease and resume runner
are real. No broker, model, active host or original engine database is used.
"""
import asyncio
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace
from typing import TypedDict
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
sys.path.insert(0, str(Path(__file__).parent))
from private_infrastructure import OwnedInfrastructure, safe_env, read_private, write_private
from engine_runtime import configuration
from local_runner import database_connection
shared_spec = importlib.util.spec_from_file_location("synplex_input_check", Path(__file__).with_name("input-postgres-check.py"))
shared_check = importlib.util.module_from_spec(shared_spec)
shared_spec.loader.exec_module(shared_check)
engine_url = shared_check.engine_url


def child_configuration(engine_root, evidence):
    saved, _, data = configuration(engine_root)
    intent = read_private(evidence / "intent.json")
    database = intent["database"]
    if (intent["engineRoot"] != str(engine_root) or data["model_mode"] != "disabled"
            or saved["providerConfigured"] or not database.startswith("synplex_input_worker_")):
        raise RuntimeError("Only the original model-disabled private fixture is allowed")
    sys.path.insert(0, saved["backend"])
    os.environ.update(DATABASE_URL=engine_url(data, database).render_as_string(hide_password=False),
        REPLICA_DATABASE_URL="", REDIS_URL="redis://127.0.0.1:1/0", OPENAI_API_KEY="",
        OPENAI_FALLBACK_API_KEY="", OPENAI_FALLBACK_ENABLED="false", TAVILY_API_KEY="",
        ADMIN_API_KEY="", OTEL_SDK_DISABLED="true", DEBUG="false")
    return data, intent


def forbid_external_http():
    import httpx
    original = httpx.AsyncClient.send
    async def only_asgi(client, request, *args, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport):
            raise AssertionError("Only in-process ASGI permitted; no model HTTP")
        return await original(client, request, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("No model, broker or external HTTP allowed")
    httpx.AsyncClient.send, httpx.Client.send = only_asgi, forbidden
    from kombu.messaging import Producer
    Producer.publish = forbidden
    from app.core.model_gateway import ModelGateway
    ModelGateway.invoke = forbidden
    ModelGateway.stream = forbidden


class FixtureState(TypedDict, total=False):
    execution_id: str
    organization_id: str
    user_id: str | None
    question_id: str
    crash_after_effect: bool
    answer: str
    final_output: str


async def effect(eid, kind):
    from app.database import async_session_factory
    from sqlalchemy import text
    async with async_session_factory() as session:
        await session.execute(text("INSERT INTO synplex_free_worker_effects(execution_id,kind) VALUES (:id,:kind)"),
            {"id": eid, "kind": kind})
        await session.commit()


def fixture_graph(*, checkpointer, dag=None):
    from langgraph.graph import StateGraph, START, END
    from langgraph.types import interrupt
    async def before(state):
        await effect(state["execution_id"], "completed_before_question")
        return {}
    async def question(state):
        answer = interrupt({"type": "clarification", "clarification": {"clarification_id": state["question_id"]}})
        return {"answer": answer["answer"]}
    async def after(state):
        await effect(state["execution_id"], "external_effect")
        if state["crash_after_effect"]:
            os._exit(73)  # Deliberately bypass finally, after the durable side effect.
        return {"final_output": "已按补充要求完成：" + state["answer"]}
    graph = StateGraph(FixtureState)
    graph.add_node("before", before)
    graph.add_node("question", question)
    graph.add_node("after", after)
    graph.add_edge(START, "before")
    graph.add_edge("before", "question")
    graph.add_edge("question", "after")
    graph.add_edge("after", END)
    return graph.compile(checkpointer=checkpointer)


async def seed(intent):
    from sqlalchemy import text
    from app.database import master_engine, async_session_factory
    from app.models import Base, Organization, Workflow, Execution, Clarification
    from app.models.enums import ExecutionStatus
    from app.engine.checkpoint import get_checkpoint_manager
    from input_delivery import initialize
    # The reviewed private PG binary already has vector installed. Activate it
    # only in this new fixture DB because real runner relationships need the
    # complete legacy schema. No binary/extension is downloaded or installed.
    async with master_engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION vector"))
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(text("CREATE TABLE synplex_free_worker_effects(execution_id TEXT,kind TEXT)"))
    await initialize(master_engine)
    org, wid = uuid.UUID(intent["organizationId"]), uuid.UUID(intent["workflowId"])
    async with async_session_factory() as session:
        session.add(Organization(id=org, name="确定性续接测试", slug="worker-" + uuid.uuid4().hex))
        await session.flush()
        session.add(Workflow(id=wid, organization_id=org, name="确定性续接", created_by="isolated-fixture"))
        await session.flush()
        for item in intent["questions"]:
            eid, qid = uuid.UUID(item["executionId"]), uuid.UUID(item["questionId"])
            session.add(Execution(id=eid, workflow_id=wid, organization_id=org, user_input="确定性续接测试",
                status=ExecutionStatus.WAITING_FOR_APPROVAL,
                checkpoint_data={"interrupt": {"type": "clarification", "clarification": {"clarification_id": str(qid)}}}))
            await session.flush()
            session.add(Clarification(id=qid, execution_id=eid, organization_id=org,
                question="需要什么格式？", options=["文字", "表格"], status="pending"))
        await session.commit()
    async with get_checkpoint_manager() as manager:
        graph = fixture_graph(checkpointer=manager.saver)
        for item in intent["questions"]:
            initial = {"execution_id": item["executionId"], "organization_id": str(org), "user_id": None,
                "question_id": item["questionId"], "crash_after_effect": item["crash"]}
            result = await graph.ainvoke(initial, {"configurable": {"thread_id": item["executionId"]}})
            assert result["__interrupt__"]
    await master_engine.dispose()


async def answer(intent):
    import httpx
    from fastapi import FastAPI
    from app.api.deps import get_current_user
    from app.database import master_engine
    from input_delivery import install_api
    app = FastAPI()
    install_api(app, {"workflow_id": intent["workflowId"], "organization_id": intent["organizationId"]})
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(organization_id=uuid.UUID(intent["organizationId"]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://worker-fixture") as client:
        for item in intent["questions"]:
            response = await client.post("/api/dispatch/clarifications/" + item["questionId"] + "/answer", json={"answer": "文字"})
            assert response.status_code == 202
            assert response.json()["execution_id"] == item["executionId"]
    await master_engine.dispose()


def worker(intent, index):
    from app.engine import runner
    from app.engine.tasks import resume_workflow_task
    from input_delivery import install_worker
    runner.build_graph = fixture_graph  # No planner/model call; other runner logic is real.
    async def local_event(execution_id, payload):
        await effect(execution_id, "event:" + payload["event"])
    runner.publish_execution_event = local_event  # Do not connect to any broker.
    install_worker()
    item = intent["questions"][index]
    resume_workflow_task.run(item["executionId"], {"answer": "文字", "synplexInputId": item["questionId"]})


def run(engine_root, evidence):
    import psycopg
    from psycopg import sql
    from engine_recovery import database_state
    saved, infra, data = configuration(engine_root)
    if data["model_mode"] != "disabled" or saved["providerConfigured"]:
        raise RuntimeError("Use a model-disabled private engine")
    if evidence.exists():
        raise RuntimeError("Evidence exists; inspect actual phases and database before any continuation")
    evidence.mkdir(mode=0o700, parents=True)
    database = "synplex_input_worker_" + uuid.uuid4().hex[:20]
    intent = {"engineRoot": str(engine_root), "database": database, "organizationId": str(uuid.uuid4()),
        "workflowId": str(uuid.uuid4()), "questions": [{"executionId": str(uuid.uuid4()), "questionId": str(uuid.uuid4()), "crash": crash} for crash in [False, True]],
        "modelCalls": 0, "status": "in_progress"}
    write_private(evidence / "intent.json", intent)
    lock = open(engine_root / "startup.lock", "a+")
    os.chmod(lock.name, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    owned, children = OwnedInfrastructure(infra), []
    def phase(name, expected=0, index=None):
        log = open(evidence / (name + ".log"), "xb")
        os.chmod(log.name, 0o600)
        try:
            args = [sys.executable, "-B", str(Path(__file__).resolve()), "--phase", name.split('-')[0], str(engine_root), str(evidence)]
            if index is not None:
                args.append(str(index))
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=safe_env())
            children.append(process)
            code = process.wait(timeout=45)
            write_private(evidence / (name + ".json"), {"exitCode": code, "expectedExitCode": expected, "modelCalls": 0})
            assert code == expected, "Phase failed; preserve database and inspect " + name
        finally:
            log.close()
    try:
        owned.start_database()
        before = database_state(data)
        write_private(evidence / "original-before.json", before)
        with psycopg.connect(**database_connection(data, "postgres"), autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database)))
        phase("seed")
        owned.close()
        owned = OwnedInfrastructure(infra)
        owned.start_database()
        phase("answer-after-database-restart")
        phase("worker-normal", index=0)
        phase("worker-normal-duplicate", index=0)
        phase("worker-hard-crash", expected=73, index=1)
        phase("worker-crash-duplicate", index=1)
        with psycopg.connect(**database_connection(data, database)) as connection:
            effects = connection.execute("SELECT execution_id,kind,count(*) FROM synplex_free_worker_effects GROUP BY execution_id,kind ORDER BY execution_id,kind").fetchall()
            states = []
            for item in intent["questions"]:
                eid, qid = item["executionId"], item["questionId"]
                assert connection.execute("SELECT count(*) FROM synplex_free_worker_effects WHERE execution_id=%s AND kind='completed_before_question'", (eid,)).fetchone()[0] == 1
                assert connection.execute("SELECT count(*) FROM synplex_free_worker_effects WHERE execution_id=%s AND kind='external_effect'", (eid,)).fetchone()[0] == 1
                status, attempts, output = connection.execute("SELECT status,run_attempt,final_output FROM executions WHERE id=%s", (eid,)).fetchone()
                state = connection.execute("SELECT state FROM synplex_input_deliveries WHERE question_id=%s", (qid,)).fetchone()[0]
                assert attempts == 1
                assert (status, state) == (("running", "running") if item["crash"] else ("completed", "finished"))
                if not item["crash"]:
                    assert "文字" in output
                states.append({"executionId": eid, "status": status, "deliveryState": state, "leaseAttempts": attempts})
            assert connection.execute("SELECT count(*) FROM outbox_events").fetchone()[0] == 2
            assert connection.execute("SELECT count(*) FROM usage_events").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM model_configs").fetchone()[0] == 0
        after = database_state(data)
        assert before == after, "Original database changed"
        write_private(evidence / "original-after.json", after)
        with psycopg.connect(**database_connection(data, "postgres"), autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database)))
        write_private(evidence / "result.json", {"status": "passed", "modelCalls": 0, "states": states,
            "effects": effects, "originalTableCount": len(before), "originalDatabaseUnchanged": True,
            "checks": ["original checkpoint survives process and database restart", "answer uses actual scoped API and durable outbox",
                "actual installed worker guard, lease and resume runner continue the same checkpoint", "completed node is not repeated",
                "separate-process duplicate messages do not repeat external effects", "hard exit after effect preserves unresolved running identity without retry"],
            "limitations": ["deterministic graph nodes replace model/planner nodes", "event transport uses fixture database instead of broker",
                "worker task .run invoked directly; real broker/outbox dispatch not exercised", "no provider or Codex/DSH validation",
                "crashed running identity requires reconciliation; it is not auto-recovered or declared successful"]})
        write_private(evidence / "intent.json", {**intent, "status": "passed"})
        print("Worker/runner durable input check passed; modelCalls=0")
    finally:
        for process in children:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        try:
            if owned.children and owned.children[0].poll() is None:
                current = database_state(data)
                write_private(evidence / "original-finally.json", current)
                assert current == read_private(evidence / "original-before.json")
        finally:
            try:
                owned.close()
            finally:
                lock.close()


if __name__ == "__main__":
    def stop(*args):
        raise KeyboardInterrupt("Stop only owned fixture processes")
    signal.signal(signal.SIGTERM, stop)
    if sys.argv[1:2] == ["--phase"]:
        mode, engine_root, evidence = sys.argv[2], Path(sys.argv[3]).resolve(), Path(sys.argv[4]).resolve()
        _, intent = child_configuration(engine_root, evidence)
        forbid_external_http()
        if mode == "seed":
            asyncio.run(seed(intent))
        elif mode == "answer":
            asyncio.run(answer(intent))
        else:
            assert mode == "worker"
            worker(intent, int(sys.argv[5]))
    else:
        run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).absolute())
