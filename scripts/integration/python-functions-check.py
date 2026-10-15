"""Free private PG -> real ToolExecutor -> bounded Python -> artifact/download.

No provider, broker or existing product database. Expected failure is preserved.
"""
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from private_infrastructure import OwnedInfrastructure, prepare, safe_env, write_private
from python_cases import sandbox_profile
spec = importlib.util.spec_from_file_location("graph_helpers", Path(__file__).with_name("full-graph-check.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def boundary_probe(evidence):
    # Trusted probe only. It attempts access to this script's own sentinel and
    # local listener, never DSH, Weave, credentials or any existing service.
    sentinel = evidence / "outside-sandbox.txt"
    sentinel.write_text("PRIVATE_FIXTURE_UNCHANGED")
    with socket.socket() as listener, tempfile.TemporaryDirectory(prefix="synplex-code-boundary-") as scratch:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        out, err = Path(scratch) / "out", Path(scratch) / "err"
        code = f'''import os,json,socket,subprocess
blocked=[]
def attempt(label,fn):
    try: fn()
    except PermissionError: blocked.append(label)
attempt('private_read',lambda:open({str(sentinel)!r}).read())
attempt('private_write',lambda:open({str(sentinel)!r},'w').write('changed'))
attempt('network',lambda:socket.create_connection(('127.0.0.1',{port}),timeout=1))
attempt('child_process',lambda:subprocess.run(['/usr/bin/true'],check=True))
attempt('other_process_signal',lambda:os.kill({os.getpid()},0))
print(json.dumps(blocked))
'''
        with out.open("xb") as output, err.open("xb") as error:
            result = subprocess.run(["/usr/bin/sandbox-exec", "-p", sandbox_profile(out, err),
                str(Path(sys.executable).resolve()), "-I", "-S", "-B", "-c", code], stdout=output, stderr=error,
                cwd=scratch, env={"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"}, timeout=5)
        assert result.returncode == 0, "Trusted OS boundary probe did not complete"
        blocked = json.loads(out.read_bytes())
        assert blocked == ["private_read", "private_write", "network", "child_process", "other_process_signal"], blocked
        assert sentinel.read_text() == "PRIVATE_FIXTURE_UNCHANGED"
        write_private(evidence / "sandbox-boundary.json", {"status": "passed", "blocked": blocked, "onlyOwnFixtures": True})


def runtime_guard_checks():
    from python_cases import check_functions
    observed = []
    for bad in [b"def f(): return f()", b"def f(): return [0]*1000000000000"]:
        raw_tests = json.dumps({"function": "f", "cases": [{"label": "运行上限", "args": [], "kwargs": {}, "expected": 0}]}).encode()
        limited = check_functions({"name": "bounded.py"}, bad, {"name": "cases.json"}, raw_tests)
        assert not limited["passed"] and not limited["complete"] and limited["cases"][0]["status"] == "incomplete"
        observed.append(limited["cases"][0]["status"])
    return {"status": "passed", "callDepthAndAllocationLimits": observed, "modelCalls": 0}


async def scenario(evidence):
    import httpx
    from fastapi import FastAPI
    from sqlalchemy import select, text, func
    from app.database import master_engine, replica_engine, async_session_factory
    from app.models import Base, Organization, User, Workflow, Execution, ToolCall, UsageEvent
    from app.models.enums import ExecutionStatus
    from app.models.artifact import Artifact
    from app.api.deps import get_current_user
    from app.api.routes.artifacts import router as artifact_router
    from app.engine import tool_executor
    from task_files import initialize, save_files, inventory
    from task_tools import install
    from python_cases import check_functions
    def forbidden(*args, **kwargs):
        raise AssertionError("Model or broker forbidden")
    from app.core.model_gateway import ModelGateway
    from kombu.messaging import Producer
    ModelGateway.invoke = ModelGateway.stream = Producer.publish = forbidden
    send = httpx.AsyncClient.send
    async def guarded_send(client, request, *args, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport):
            raise AssertionError("External HTTP forbidden")
        return await send(client, request, *args, **kwargs)
    httpx.AsyncClient.send, httpx.Client.send = guarded_send, forbidden
    async def event(*args, **kwargs):
        pass
    tool_executor.publish_execution_event = tool_executor.record_span = event
    install()
    async with master_engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION vector"))
        await connection.run_sync(Base.metadata.create_all)
    await initialize(master_engine)
    org, uid, wid, eid, foreign_eid = (uuid.uuid4() for _ in range(5))
    source = b"def total(values):\n    amount=0\n    for value in values:\n        amount += value\n    return amount\n"
    tests = json.dumps({"function": "total", "cases": [
        {"label": "正负收入", "args": [[10, -3, 2]], "kwargs": {}, "expected": 9},
        {"label": "故意错误的预期，不得全判通过", "args": [[1, 2]], "kwargs": {}, "expected": 99}]}).encode()
    def uploaded(name, raw):
        return {"sourceId": name, "occurrenceId": name + "-event", "name": name,
            "sha256": hashlib.sha256(raw).hexdigest(), "byteLength": len(raw), "mediaType": "text/plain",
            "contentBase64": base64.b64encode(raw).decode()}
    files = [uploaded("income.py", source), uploaded("cases.json", tests)]
    async with async_session_factory() as session:
        session.add(Organization(id=org, name="函数测试夹具", slug="functions-" + org.hex))
        await session.flush()
        session.add(User(id=uid, organization_id=org, email="functions@synplex.invalid", password_hash="disabled", role="admin"))
        session.add(Workflow(id=wid, organization_id=org, name="受限函数", created_by=str(uid)))
        await session.flush()
        for execution_id in (eid, foreign_eid):
            session.add(Execution(id=execution_id, organization_id=org, workflow_id=wid, user_id=uid,
                user_input="只做指定函数样本测试", current_step_index=0, status=ExecutionStatus.RUNNING))
        await session.flush()
        await save_files(session, eid, files)
        await session.commit()
    code, samples = inventory(files)
    params = {"code_file_key": code["file_key"], "tests_file_key": samples["file_key"], "title": "函数样本核对"}
    report = await tool_executor.execute_tool("test_task_python", params, eid, user_id=uid)
    assert report["status"] == "success", report
    validation = report["data"]["validation"]
    assert not validation["passed"] and validation["complete"]
    assert [c["status"] for c in validation["cases"]] == ["passed", "failed"]
    assert not validation["kernelMemoryLimit"] and not validation["expectedValuesPassedToProgram"]
    assert (await tool_executor.execute_tool("test_task_python", params, eid, user_id=uid))["status"] == "duplicate"
    assert (await tool_executor.execute_tool("test_task_python", params, foreign_eid, user_id=uid))["status"] == "failed"
    assert (await tool_executor.execute_tool("test_task_python", {**params, "path": "/forbidden"}, eid, user_id=uid))["status"] == "failed"
    # Distinct runtime guards: runaway calls and a huge requested allocation.
    # Both are refused inside the restricted child, not executed in this parent.
    await asyncio.to_thread(runtime_guard_checks)
    app = FastAPI()
    app.include_router(artifact_router, prefix="/api")
    identity = type("Identity", (), {"id": uid, "organization_id": org, "role": "admin", "is_active": True})()
    app.dependency_overrides[get_current_user] = lambda: identity
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
        response = await client.get("/api/artifacts/" + report["data"]["id"] + "/download")
        assert response.status_code == 200 and hashlib.sha256(response.content).hexdigest() == report["data"]["sha256"]
        assert "结果不符合预期" in response.text and "整个项目" not in response.text
        assert "通过只证明所选测试样本" in response.text and files[0]["sha256"] in response.text
        identity.organization_id = uuid.uuid4()
        assert (await client.get("/api/artifacts/" + report["data"]["id"] + "/download")).status_code == 404
    async with async_session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(Artifact)) == 1
        assert await session.scalar(select(func.count()).select_from(UsageEvent)) == 0
        stored = (await session.execute(select(ToolCall))).scalars().all()
        assert len(stored) == 3
    write_private(evidence / "result.json", {"status": "passed", "modelCalls": 0,
        "realToolExecutor": True, "realMacSandbox": True, "realFunctionExecution": True,
        "realArtifactAndAuthenticatedDownload": True, "selectedSamples": ["passed", "failed"],
        "duplicateCreatesNoArtifact": True, "foreignExecutionAndOrganizationRefused": True,
        "kernelHardMemoryLimit": False, "restrictedSyntaxOnly": True, "realModelToolChoiceVerified": False})
    await master_engine.dispose()
    await replica_engine.dispose()


def run(backend, evidence, pg_bin):
    if evidence.exists():
        raise RuntimeError("Evidence exists; inspect previous outcomes")
    infrastructure = prepare(evidence, pg_bin, port=helpers.port())
    queue = evidence / "queue"
    queue.mkdir(mode=0o700)
    write_private(queue / "bootstrap.json", {"redis_port": 1, "redis_password": "disabled-fixture"})
    boundary_probe(evidence)
    owned = OwnedInfrastructure(infrastructure)
    try:
        owned.start_database()
        with open(evidence / "scenario.log", "xb") as log:
            os.chmod(log.name, 0o600)
            result = subprocess.run([sys.executable, "-B", __file__, "--child", str(backend), str(evidence)],
                stdout=log, stderr=log, env=safe_env(), cwd=evidence, timeout=60)
        if result.returncode:
            raise RuntimeError("Function check failed; inspect preserved scenario.log")
    finally:
        owned.close()


if __name__ == "__main__":
    if sys.argv[1] == "--guards":
        output = Path(sys.argv[2]).resolve()
        if output.exists():
            raise RuntimeError("Guard evidence exists; inspect it without replay")
        write_private(output, runtime_guard_checks())
    elif sys.argv[1] == "--child":
        helpers.configure(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
        asyncio.run(scenario(Path(sys.argv[3]).resolve()))
    else:
        run(*(Path(p).absolute() for p in sys.argv[1:]))
