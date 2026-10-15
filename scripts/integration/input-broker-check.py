"""Free answer/outbox/broker/worker check with a real publication commit gap.

Reuses the reviewed model-disabled private PG cluster, in a new database. Queue
data and worker processes belong only to this evidence directory. Graph nodes
are deterministic; the API, outbox publisher, Celery transport, execution guard,
lease, persistent graph, event bus and worker-return receipt are actual code.
"""
import asyncio
import fcntl
import importlib.util
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
spec = importlib.util.spec_from_file_location("synplex_worker_check", Path(__file__).with_name("input-worker-check.py"))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
from private_infrastructure import OwnedInfrastructure, safe_env, read_private, write_private, available
from engine_runtime import configuration
from local_runner import database_connection


def child_configuration(engine_root, evidence):
    data, intent = shared.child_configuration(engine_root, evidence)
    queue = read_private(evidence / "queue/bootstrap.json")
    redis_url = f'redis://:{queue["redis_password"]}@127.0.0.1:{queue["redis_port"]}/0'
    # Ignore every inherited .env/default integration endpoint, just as the
    # reviewed isolated runtime does. Do not read another host's credentials.
    from app import config
    defaults = {name: field.get_default(call_default_factory=True) for name, field in config.Settings.model_fields.items()}
    defaults.update(DATABASE_URL=shared.engine_url(data, intent["database"]).render_as_string(hide_password=False),
        REDIS_URL=redis_url, REPLICA_DATABASE_URL="", OPENAI_API_KEY="", OPENAI_FALLBACK_API_KEY="",
        OPENAI_FALLBACK_ENABLED=False, TAVILY_API_KEY="", ADMIN_API_KEY="", OTEL_SDK_DISABLED=True,
        JWT_SECRET_KEY=queue["redis_password"], ARTIFACT_ROOT=str(evidence / "artifacts"),
        MCP_CONNECTORS_JSON="[]", SYNPLEX_CONNECTIONS_FILE="", SYNPLEX_EXTENSION_ROOT="")
    config.settings = config.Settings(_env_file=None, **defaults)
    config.get_settings.cache_clear()
    config.get_settings = lambda: config.settings
    import httpx
    original_http, original_connect = httpx.AsyncClient.send, socket.socket.connect
    async def only_asgi(client, request, *args, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport):
            raise AssertionError("Free check forbids model/external HTTP")
        return await original_http(client, request, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("Free check forbids all model calls")
    def private_connect(sock, address):
        if not isinstance(address, tuple) or address[0] != "127.0.0.1" or address[1] not in {data["database_port"], queue["redis_port"]}:
            raise AssertionError("Only this check's private PostgreSQL and queue are allowed")
        return original_connect(sock, address)
    httpx.AsyncClient.send, httpx.Client.send = only_asgi, forbidden
    socket.socket.connect = private_connect
    from app.core.model_gateway import ModelGateway
    ModelGateway.invoke, ModelGateway.stream = forbidden, forbidden
    from app.engine.tasks import celery_app
    celery_app.conf.update(task_default_queue="synplex-free-input", task_routes={"agenthub.resume_workflow": {"queue": "synplex-free-input"}},
        broker_connection_retry_on_startup=False, task_publish_retry=False)
    return data, intent


def worker(intent, evidence, generation):
    from app.engine import runner
    from app.engine.tasks import celery_app, run_worker_async
    from celery.signals import worker_ready, task_postrun
    from input_delivery import install_worker
    from local_runner import install_worker_receipt
    runner.build_graph = shared.fixture_graph
    install_worker()
    install_worker_receipt({"workflow_id": intent["workflowId"], "organization_id": intent["organizationId"]})
    def ready(**ignored):
        write_private(evidence / f"worker-{generation}-ready.json", {"pid": os.getpid(), "modelCalls": 0})
    def returned(sender=None, args=None, kwargs=None, state=None, **ignored):
        if getattr(sender, "name", None) == "agenthub.resume_workflow" and state == "SUCCESS":
            eid = (kwargs or {}).get("execution_id") or (args[0] if args else None)
            run_worker_async(shared.effect(eid, "broker_task_returned"))
    worker_ready.connect(ready, weak=False)
    task_postrun.connect(returned, weak=False)
    celery_app.worker_main(["worker", "--pool=solo", "--concurrency=1", "--loglevel=WARNING",
        "--queues=synplex-free-input", "--without-gossip", "--without-mingle", "--without-heartbeat"])


async def dispatch(evidence, fail_commit):
    from app.database import master_engine, async_session_factory
    from app.engine.outbox import dispatch_outbox_batch
    from app.engine.tasks import resume_workflow_task
    ids = []
    def publish(**payload):
        task = resume_workflow_task.delay(**payload)
        ids.append(task.id)
        write_private(evidence / ("publish-gap.json" if fail_commit else "publish-retry.json"), {"messageIds": ids, "modelCalls": 0})
    async with async_session_factory() as session:
        if fail_commit:
            async def commit_gap():
                raise RuntimeError("fixture: message published, DB commit lost")
            session.commit = commit_gap
        try:
            result = await dispatch_outbox_batch(session, {"resume_workflow": publish}, limit=1)
            assert not fail_commit
            assert result == {"published": 1, "failed": 0}
        except RuntimeError as error:
            assert fail_commit and str(error) == "fixture: message published, DB commit lost"
            await session.rollback()
    assert len(ids) == 1
    await master_engine.dispose()


def run(engine_root, evidence, queue_port):
    import psycopg
    from psycopg import sql
    from engine_recovery import database_state
    saved, infra, data = configuration(engine_root)
    if data["model_mode"] != "disabled" or saved["providerConfigured"] or evidence.exists():
        raise RuntimeError("Use a model-disabled private engine and a new evidence directory; inspect prior results first")
    available(queue_port)
    evidence.mkdir(mode=0o700, parents=True)
    queue = evidence / "queue"
    queue.mkdir(mode=0o700)
    (queue / "data").mkdir(mode=0o700)
    queue_data = {"redis_port": queue_port, "redis_password": secrets.token_hex(32), "infrastructure_id": infra["id"]}
    write_private(queue / "bootstrap.json", queue_data)
    config = f'bind 127.0.0.1\nport {queue_port}\nprotected-mode yes\nrequirepass {queue_data["redis_password"]}\ndir "{queue / "data"}"\nappendonly yes\nsave ""\ndaemonize no\n'
    fd = os.open(queue / "valkey.conf", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(config)
    database = "synplex_input_worker_" + uuid.uuid4().hex[:20]
    item = {"executionId": str(uuid.uuid4()), "questionId": str(uuid.uuid4()), "crash": False}
    intent = {"engineRoot": str(engine_root), "database": database, "organizationId": str(uuid.uuid4()),
        "workflowId": str(uuid.uuid4()), "questions": [item], "modelCalls": 0, "status": "in_progress"}
    write_private(evidence / "intent.json", intent)
    lock = open(engine_root / "startup.lock", "a+")
    os.chmod(lock.name, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    owned, children, logs = OwnedInfrastructure(infra), [], []
    def spawn(phase, generation=None):
        name = phase + ("-" + str(generation) if generation is not None else "")
        log = open(evidence / (name + ".log"), "xb")
        os.chmod(log.name, 0o600)
        logs.append(log)
        args = [sys.executable, "-B", str(Path(__file__).resolve()), "--phase", phase, str(engine_root), str(evidence)]
        if generation is not None:
            args.append(str(generation))
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=safe_env())
        children.append(child)
        return child
    def phase(name):
        code = spawn(name).wait(timeout=45)
        write_private(evidence / (name + ".json"), {"exitCode": code, "modelCalls": 0})
        assert code == 0, "Inspect preserved phase: " + name
    def wait_for(predicate, child=None):
        deadline = time.monotonic() + 35
        while not predicate():
            if child is not None and child.poll() is not None:
                raise RuntimeError("Owned worker exited; inspect its phase log")
            if time.monotonic() > deadline:
                raise RuntimeError("Fixture timed out; preserve original identities, do not replay")
            time.sleep(0.1)
    def returned(count):
        with psycopg.connect(**database_connection(data, database)) as connection:
            return connection.execute("SELECT count(*) FROM synplex_free_worker_effects WHERE kind='broker_task_returned'").fetchone()[0] == count
    try:
        owned.start_database()
        before = database_state(data)
        write_private(evidence / "original-before.json", before)
        with psycopg.connect(**database_connection(data, "postgres"), autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(database)))
        phase("seed")
        phase("answer")
        owned.start_queue(saved["valkey"], queue)
        first = spawn("worker", 1)
        wait_for(lambda: (evidence / "worker-1-ready.json").exists(), first)
        phase("dispatch-gap")
        wait_for(lambda: returned(1), first)
        with psycopg.connect(**database_connection(data, database)) as connection:
            assert connection.execute("SELECT published_at FROM outbox_events").fetchone()[0] is None
        first.terminate()
        assert first.wait(timeout=15) == 0
        second = spawn("worker", 2)
        wait_for(lambda: (evidence / "worker-2-ready.json").exists(), second)
        phase("dispatch-retry")
        wait_for(lambda: returned(2), second)
        second.terminate()
        assert second.wait(timeout=15) == 0
        with psycopg.connect(**database_connection(data, database)) as connection:
            effects = dict(connection.execute("SELECT kind,count(*) FROM synplex_free_worker_effects GROUP BY kind").fetchall())
            assert effects == {"completed_before_question": 1, "external_effect": 1, "broker_task_returned": 2}
            status, attempts, output, checkpoint = connection.execute("SELECT status,run_attempt,final_output,checkpoint_data FROM executions").fetchone()
            assert (status, attempts) == ("completed", 1) and "文字" in output
            receipt = checkpoint["synplexWorkerReceipt"]
            assert receipt["executionId"] == item["executionId"] and receipt["workerReturned"] is True
            assert connection.execute("SELECT state FROM synplex_input_deliveries").fetchone()[0] == "finished"
            assert connection.execute("SELECT count(*) FROM outbox_events WHERE published_at IS NOT NULL").fetchone()[0] == 1
            assert connection.execute("SELECT count(*) FROM execution_events").fetchone()[0] > 0
            assert connection.execute("SELECT count(*) FROM usage_events").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM model_configs").fetchone()[0] == 0
        assert before == database_state(data), "Original engine database changed"
        write_private(evidence / "original-after.json", before)
        with psycopg.connect(**database_connection(data, "postgres"), autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database)))
        write_private(evidence / "result.json", {"status": "passed", "modelCalls": 0, "effects": effects,
            "originalDatabaseUnchanged": True, "originalTableCount": len(before), "executionId": item["executionId"],
            "checks": ["actual answer API creates one durable outbox intent", "actual outbox publisher sends Celery message over private Valkey",
                "lost DB publication commit leaves original event unpublished", "actual solo worker continues original persistent graph",
                "after worker restart explicit original outbox dispatch delivers a duplicate without repeating effects",
                "real event bus and worker-return receipt persist original execution identity"],
            "limitations": ["graph nodes deterministic, no model or planner", "API uses in-process ASGI, not network server", "no active host or shared infrastructure", "not hard-kill broker recovery or production reliability evidence"]})
        write_private(evidence / "intent.json", {**intent, "status": "passed"})
        print("Actual outbox/broker/worker continuation passed; modelCalls=0")
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=15)
        for log in logs:
            log.close()
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
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    if sys.argv[1:2] == ["--phase"]:
        mode, engine_root, evidence = sys.argv[2], Path(sys.argv[3]).resolve(), Path(sys.argv[4]).resolve()
        _, intent = child_configuration(engine_root, evidence)
        if mode == "seed":
            asyncio.run(shared.seed(intent))
        elif mode == "answer":
            asyncio.run(shared.answer(intent))
        elif mode == "worker":
            worker(intent, evidence, int(sys.argv[5]))
        else:
            assert mode in {"dispatch-gap", "dispatch-retry"}
            asyncio.run(dispatch(evidence, mode == "dispatch-gap"))
    else:
        run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).absolute(), int(sys.argv[3]))
