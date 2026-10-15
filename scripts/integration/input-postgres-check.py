"""One free PostgreSQL contention check; no API/queue/model service is started.

Reuses a stopped, ownership-checked private cluster, creates a new test database,
and never changes the engine's original database. Failure preserves test data.
"""
import asyncio
import fcntl
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from private_infrastructure import OwnedInfrastructure, read_private, write_private, safe_env
from engine_runtime import configuration
from local_runner import database_connection


def engine_url(data, database):
    from sqlalchemy.engine import URL
    return URL.create("postgresql+asyncpg", username=data["database_user"],
        password=data["database_password"], host="127.0.0.1",
        port=data["database_port"], database=database)


async def claim_worker(engine_root, database, qid, eid, output):
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from input_delivery import claim_once
    _, _, data = configuration(engine_root)
    if not database.startswith("synplex_input_check_"):
        raise RuntimeError("Only a dedicated input-check database may be used")
    engine = create_async_engine(engine_url(data, database))
    try:
        async with async_sessionmaker(engine)() as session:
            claimed = await claim_once(session, qid, eid, "文字")
            await session.commit()
        write_private(output, {"claimed": claimed, "modelCalls": 0})
    finally:
        await engine.dispose()


async def inspect_delivery_api(client, sessions, evidence, qid, eid, org, user, data, database):
    from sqlalchemy import text
    from input_delivery import insert_intent
    from app.models import Clarification
    from engine_recovery import database_state
    route = f"/api/synplex/executions/{eid}/input-deliveries/{qid}"
    assert (await client.get(route)).status_code == 404
    async with sessions() as session:
        q = await session.get(Clarification, qid)
        q.status, q.answer = "answered", "文字"
        await insert_intent(session, qid, eid, "文字")
        await session.commit()
    baseline = database_state({**data, "database": database})
    receipt = (await client.get(route)).json()
    import hashlib
    assert receipt == {"protocol": "synplex.input-delivery/1", "executionId": str(eid),
        "questionId": str(qid), "answerSha256": hashlib.sha256("文字".encode()).hexdigest(), "deliveryState": "queued"}
    assert (await client.get(route.replace(str(eid), str(uuid.uuid4())))).status_code == 404
    user.organization_id = uuid.uuid4()
    assert (await client.get(route)).status_code == 404
    user.organization_id = org
    assert baseline == database_state({**data, "database": database}), "GET mutated persisted records"
    async with sessions() as session:
        await session.execute(text("UPDATE synplex_input_deliveries SET state='unknown'"))
        await session.commit()
    baseline = database_state({**data, "database": database})
    assert (await client.get(route)).json()["deliveryState"] == "unknown"
    assert baseline == database_state({**data, "database": database})
    async with sessions() as session:
        await session.execute(text("UPDATE synplex_input_deliveries SET answer_hash=:hash"), {"hash": "0" * 64})
        await session.commit()
    baseline = database_state({**data, "database": database})
    assert (await client.get(route)).status_code == 409
    assert baseline == database_state({**data, "database": database})
    write_private(evidence / "inspection.json", {"checks": ["unsaved answer is not reported sent",
        "stored answer hash and original execution identity", "different execution and organization refused",
        "unknown continuation is not execution success", "corrupt answer receipt refused", "GET leaves every table unchanged"],
        "fixture": "seeded answer without dispatch", "modelCalls": 0})


async def check_api(saved, data, database, evidence, *, inspection_only=False):
    import httpx
    from fastapi import FastAPI
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
    from input_delivery import initialize, install_api, delivery
    sys.path.insert(0, saved["backend"])
    from app.models import Organization, Workflow, Execution, Clarification, OutboxEvent
    from app.models.base import Base
    from app.models.enums import ExecutionStatus
    from app.api.deps import get_current_user
    from app.database import get_db

    # Only an in-process ASGI client is permitted. No model/gateway HTTP can run.
    original_send, original_sync_send = httpx.AsyncClient.send, httpx.Client.send
    async def asgi_only(client, request, *args, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport):
            raise AssertionError("External HTTP forbidden in free input check")
        return await original_send(client, request, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("External HTTP forbidden in free input check")
    httpx.AsyncClient.send, httpx.Client.send = asgi_only, forbidden

    engine = create_async_engine(engine_url(data, database),
        connect_args={"server_settings": {"application_name": "synplex-free-input-check",
            "statement_timeout": "10000", "lock_timeout": "8000"}})
    fault = {"commit": False}
    class Session(AsyncSession):
        async def commit(self):
            if fault["commit"]:
                fault["commit"] = False
                raise RuntimeError("Fixture crash before transaction commit")
            return await super().commit()
    sessions = async_sessionmaker(engine, class_=Session, expire_on_commit=False)
    question_file = evidence / "question-intent.json"
    if question_file.exists():
        identities = read_private(question_file)
        eid, qid, org, wid = [uuid.UUID(identities[key]) for key in
            ["executionId", "questionId", "organizationId", "workflowId"]]
    else:
        eid, qid, org, wid = [uuid.uuid4() for _ in range(4)]
        write_private(question_file, {"executionId": str(eid),
            "questionId": str(qid), "organizationId": str(org), "workflowId": str(wid)})
    try:
        async with engine.begin() as connection:
            # Real legacy tables plus their foreign-key dependency closure only.
            # Unrelated vector memory tables are not part of the answer protocol.
            required = {model.__table__ for model in [Organization, Workflow, Execution, Clarification, OutboxEvent]}
            while True:
                dependencies = {key.column.table for table in required for key in table.foreign_keys}
                expanded = required | dependencies
                if expanded == required:
                    break
                required = expanded
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=list(required)))
            write_private(evidence / "schema.json", {"tables": sorted(table.name for table in required),
                "selection": "answer models and foreign-key dependency closure"})
        await initialize(engine)
        async with sessions() as session:
            session.add(Organization(id=org, name="独立测试", slug="input-" + uuid.uuid4().hex))
            await session.flush()
            session.add(Workflow(id=wid, name="独立测试", created_by="isolated-test", organization_id=org))
            await session.flush()
            session.add(Execution(id=eid, workflow_id=wid, organization_id=org, user_input="确定性补答检查",
                status=ExecutionStatus.WAITING_FOR_APPROVAL,
                checkpoint_data={"interrupt": {"type": "clarification", "clarification": {"clarification_id": str(qid)}}}))
            await session.flush()
            session.add(Clarification(id=qid, execution_id=eid, organization_id=org,
                question="需要什么格式？", options=["文字", "表格"], status="pending"))
            await session.commit()
        app, user = FastAPI(), SimpleNamespace(organization_id=org)
        from app.api.routes.dispatch import router as legacy_dispatch
        from app.engine.tasks import resume_workflow_task
        app.include_router(legacy_dispatch, prefix="/api")
        resume_workflow_task.delay = forbidden  # Atomic outbox must win over the legacy immediate publisher.
        install_api(app, {"workflow_id": str(wid), "organization_id": str(org)})
        async def db():
            async with sessions() as session:
                yield session
        app.dependency_overrides[get_db] = db
        app.dependency_overrides[get_current_user] = lambda: user
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://isolated-input") as client:
            if inspection_only:
                await inspect_delivery_api(client, sessions, evidence, qid, eid, org, user, data, database)
                return str(qid), str(eid)
            route = "/api/dispatch/clarifications/" + str(qid) + "/answer"
            fault["commit"] = True
            assert (await client.post(route, json={"answer": "文字"})).status_code == 500
            async with sessions() as session:
                assert await delivery(session, qid) is None
                assert (await session.get(Clarification, qid)).status == "pending"
                assert not (await session.execute(select(OutboxEvent))).scalars().all()
            write_private(evidence / "rollback.json", {"answer": "pending", "intentCount": 0, "outboxCount": 0})
            one, two = await asyncio.gather(client.post(route, json={"answer": "文字"}), client.post(route, json={"answer": "文字"}))
            assert one.status_code == two.status_code == 202, (one.status_code, two.status_code)
            assert one.json() == two.json()
            assert (await client.post(route, json={"answer": "表格"})).status_code == 409
            user.organization_id = uuid.uuid4()
            assert (await client.post(route, json={"answer": "文字"})).status_code == 404
            user.organization_id = org
        async with sessions() as session:
            events = (await session.execute(select(OutboxEvent))).scalars().all()
            assert len(events) == 1
            assert events[0].payload["decision"]["synplexInputId"] == str(qid)
            assert (await delivery(session, qid))["state"] == "queued"
        write_private(evidence / "answers.json", {"simultaneousResponses": [202, 202], "outboxCount": 1,
            "changedAnswer": 409, "foreignOrganization": 404, "modelCalls": 0})
        return str(qid), str(eid)
    finally:
        await engine.dispose()
        httpx.AsyncClient.send, httpx.Client.send = original_send, original_sync_send


def run(engine_root, evidence, *, resume=False, inspection_only=False):
    import psycopg
    from psycopg import sql
    from engine_recovery import database_state
    saved, infra, data = configuration(engine_root)
    if saved["providerConfigured"] or data["model_mode"] != "disabled":
        raise RuntimeError("Use an explicitly model-disabled test engine")
    if resume:
        intent = read_private(evidence / "intent.json")
        if (intent["format"] != "synplex.input-postgres-check/1"
                or intent["engineRoot"] != str(engine_root) or intent["status"] != "in_progress"):
            raise RuntimeError("Saved check identity or phase changed; inspect actual results")
        database = intent["database"]
        if any((evidence / file).exists() for file in ["rollback.json", "answers.json", "result.json",
                "claim-1.log", "claim-2.log", "claim-1.json", "claim-2.json"]):
            raise RuntimeError("This check has progressed beyond schema setup; reconcile actual results instead of replaying")
    else:
        if evidence.exists():
            raise RuntimeError("Evidence already exists; inspect actual database/results and explicitly resume")
        evidence.mkdir(mode=0o700, parents=True)
        database = "synplex_input_check_" + uuid.uuid4().hex[:20]
        intent = {"format": "synplex.input-postgres-check/1", "engineRoot": str(engine_root),
            "database": database, "modelCalls": 0, "status": "in_progress"}
        write_private(evidence / "intent.json", intent)
    if not re.fullmatch(r"synplex_input_check_[a-f0-9]{20}", database):
        raise RuntimeError("Only a dedicated input-check database may be used")
    lock = open(engine_root / "startup.lock", "a+")
    os.chmod(lock.name, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    owned, children = OwnedInfrastructure(infra), []
    try:
        owned.start_database()
        current = database_state(data)
        before_file = evidence / "original-database-before.json"
        if before_file.exists():
            before = read_private(before_file)
            assert current == before, "Original database changed; do not continue"
        else:
            if resume:
                raise RuntimeError("Original baseline missing; cannot safely resume")
            before = current
            write_private(before_file, before)
        with psycopg.connect(**database_connection(data, "postgres"), autocommit=True) as connection:
            exists = connection.execute("SELECT 1 FROM pg_database WHERE datname=%s", (database,)).fetchone()
            if resume:
                if not exists:
                    raise RuntimeError("Saved check database is absent; do not recreate it")
            else:
                if exists:
                    raise RuntimeError("Database identity already exists; preserve it")
                connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database)))
        if resume:
            with psycopg.connect(**database_connection(data, database)) as connection:
                tables = connection.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall()
                if tables:
                    raise RuntimeError("Schema/rows already exist; inspect actual progress instead of replaying")
            write_private(evidence / "resume-observation.json", {"tables": [], "originalDatabaseUnchanged": True,
                "questionIdentityPreserved": (evidence / "question-intent.json").is_file(),
                "reason": "initial full-schema transaction rolled back before seed/answer/claim"})
        qid, eid = asyncio.run(check_api(saved, data, database, evidence, inspection_only=inspection_only))
        claims = []
        if not inspection_only:
            for number in [1, 2]:
                command = [sys.executable, "-B", str(Path(__file__).resolve()), "--claim", str(engine_root), database, qid, eid, str(evidence / f"claim-{number}.json")]
                log = open(evidence / f"claim-{number}.log", "xb")
                os.chmod(log.name, 0o600)
                try:
                    children.append(subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=safe_env()))
                finally:
                    log.close()
            for child in children:
                assert child.wait(timeout=30) == 0, "Independent claim process failed; inspect its private log"
            claims = [read_private(evidence / f"claim-{number}.json")["claimed"] for number in [1, 2]]
            assert sum(claims) == 1
            with psycopg.connect(**database_connection(data, database)) as connection:
                assert connection.execute("SELECT state FROM synplex_input_deliveries WHERE question_id=%s", (qid,)).fetchone()[0] == "running"
                assert connection.execute("SELECT count(*) FROM outbox_events").fetchone()[0] == 1
        after = database_state(data)
        assert before == after, "Original engine database changed"
        write_private(evidence / "original-database-after.json", after)
        with psycopg.connect(**database_connection(data, "postgres"), autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database)))
        write_private(evidence / "result.json", {"status": "passed", "checks": read_private(evidence / "inspection.json")["checks"] if inspection_only else ["real PostgreSQL rollback is atomic",
            "two simultaneous API answers create one durable outbox", "changed answer and foreign organization refused",
            "new transaction route wins with the complete legacy router included; no immediate publishing",
            "two separate processes yield exactly one claimed intent", "claimed intent remains persisted without graph replay",
            "original database tables unchanged", "only this script's database removed"], "claims": claims,
            "originalTableCount": len(before), "scenario": "read_only_inspection" if inspection_only else "answer_contention", "modelCalls": 0,
            "limitations": ["in-process authenticated API fixture", "no real provider or worker graph continuation", "no Codex or DSH restart claim"]})
        write_private(evidence / "intent.json", {**intent, "status": "passed"})
        print("PostgreSQL input check passed; scenario=" + ("read_only_inspection" if inspection_only else "answer_contention") + "; modelCalls=0")
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
        try:
            if owned.children and owned.children[0].poll() is None:
                current = database_state(data)
                write_private(evidence / "original-database-finally.json", current)
                assert current == read_private(evidence / "original-database-before.json"), "Original database changed"
        finally:
            try:
                owned.close()
            finally:
                lock.close()


if __name__ == "__main__":
    def stop(signum, frame):
        raise KeyboardInterrupt("Stopping only owned input-check resources")
    signal.signal(signal.SIGTERM, stop)
    if sys.argv[1:2] == ["--claim"]:
        asyncio.run(claim_worker(Path(sys.argv[2]).resolve(), sys.argv[3], sys.argv[4], sys.argv[5], Path(sys.argv[6])))
    else:
        arguments = sys.argv[1:]
        resume = arguments[:1] == ["--resume"]
        inspection = arguments[:1] == ["--inspect-only"]
        if resume or inspection:
            arguments = arguments[1:]
        run(Path(arguments[0]).resolve(), Path(arguments[1]).absolute(), resume=resume, inspection_only=inspection)
