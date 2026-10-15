"""One real local PG/Valkey/API handoff, with a process crash and exact resume.

One terminal task is synthetic bookkeeping, never a model-quality result.
No provider is configured, no task is sent, and evidence is never overwritten.
"""
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from engine_runtime import setup, configuration, ensure_execution_allowed
from engine_recovery import product_snapshot, product_restore, database_state
from local_runner import database_connection
from private_infrastructure import OwnedInfrastructure, safe_env, write_private, read_private


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def ready(child, url, timeout=50):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        assert child.poll() is None, "Owned supervisor exited; inspect its log before resuming"
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Readiness timed out; do not repeat setup")


def supervised(command, log, url, check=None):
    with open(log, "xb") as output:
        os.chmod(log, 0o600)
        child = subprocess.Popen(command, cwd=ROOT, env={**safe_env(), "SYNPLEX_TEST_NO_MODELS": "1"},
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output)
        try:
            ready(child, url)
            if check:
                check()
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=30)


def node_call(node, code, args, log):
    result = subprocess.run([str(node), "--input-type=module", "-e", code, *map(str, args)],
                            cwd=ROOT, env={**safe_env(), "SYNPLEX_TEST_NO_MODELS": "1"}, capture_output=True, timeout=30)
    with open(log, "xb") as file:
        os.chmod(log, 0o600)
        file.write(result.stdout + result.stderr)
    assert result.returncode == 0, "Inspect Node log before continuing; never repeat mutations"
    return json.loads(result.stdout) if result.stdout.strip() else None


def prepare(backend, pg_bin, valkey, node, evidence, *, relay=False):
    engine, workspace = evidence / "source-engine", evidence / "source-workspace"
    ports = [port() for _ in range(3)]
    assert len(set(ports)) == 3
    setup(engine, backend, pg_bin, valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    if relay:
        from model_relay import configure
        configure(engine, "http://127.0.0.1:5411/internal/model/v1")
    runtime = ROOT / "integrations/agenthub/engine_runtime.py"
    supervised([sys.executable, "-B", str(runtime), "run", "--root", str(engine)],
               evidence / "source-supervisor.log", f"http://127.0.0.1:{ports[0]}/health/live")
    _, infra, data = configuration(engine)
    task = str(uuid.uuid4())
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        import psycopg
        with psycopg.connect(**database_connection(data, data["database"])) as db:
            db.execute("INSERT INTO executions (id,workflow_id,status,current_step_index,correlation_id,event_sequence,run_attempt,user_input,context_messages,final_output,input_tokens,output_tokens,organization_id,user_id) "
                       "VALUES (%s,%s,'completed',0,%s,0,0,%s,'[]',%s,0,0,%s,%s)",
                       (task, data["workflow_id"], str(uuid.uuid4()), "synthetic bookkeeping, not a model task",
                        "已保存的合成成果，不能当作真实模型结果", data["organization_id"], data["user_id"]))
        before = database_state(data)
    finally:
        owned.close()
    seed = """
import {seedIdleRecoveryWorkspace} from './scripts/testing/idle-recovery-fixture.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const [workspace,engine,task,file,relay]=process.argv.slice(1),data=JSON.parse(readFileSync(engine+'/engine/bootstrap.json'));
const ids=seedIdleRecoveryWorkspace(workspace,engine,data,task,{relay:relay==='true'});
writeFileSync(file,JSON.stringify(ids),{flag:'wx',mode:0o600});
"""
    node_call(node, seed, [workspace, engine, task, evidence / "bindings.json", str(relay).lower()], evidence / "seed.log")
    write_private(evidence / "baseline.json", {"engineTables": before, "taskId": task, "modelCalls": 0, "relayMode": relay})
    write_private(evidence / "stage.json", {"stage": "prepared", "setupRepeated": False, "seedRepeated": False})


def backup_restore(backend, pg_bin, valkey, node, evidence):
    snapshot, restored = evidence / "snapshot", evidence / "restored"
    if not snapshot.exists():
        product_snapshot(evidence / "source-workspace", evidence / "source-engine", snapshot, node=node)
    else:
        from engine_recovery import verify_product
        verify_product(snapshot, node=node)  # Completed backup only; never replay it.
    if not restored.exists():
        ports = [port() for _ in range(4)]
        assert len(set(ports)) == 4
        product_restore(snapshot, restored, node=node, workspace_port=ports[3], backend=backend,
                        pg_bin=pg_bin, valkey=valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    else:
        assert not (restored / "restore-incomplete.json").exists(), "Inspect incomplete restore; do not replay it"
    write_private(evidence / "stage.json", {"stage": "restored", "setupRepeated": False, "seedRepeated": False})


def crash_after_retirement(node, evidence):
    if (evidence / "source-engine/handoff-retired.json").exists():
        # An interface may have lost the expected process-exit receipt. Inspect
        # the durable result before ever injecting the same interruption again.
        proof = read_private(evidence / "restored/handoff-intent.json")["proof"]
        assert read_private(evidence / "source-engine/handoff-retired.json") == proof
        for path in [evidence / "source-engine", evidence / "restored/engine"]:
            try:
                ensure_execution_allowed(path)
            except RuntimeError:
                pass
            else:
                raise AssertionError("Unexpected admission after interrupted transfer")
        write_private(evidence / "stage.json", {"stage": "retired_interrupted", "actualRetirementInspected": True, "crashRepeated": False})
        return
    code = """
import importlib.util,os,sys,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('handoff',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.durable_json
settled=m.settled
def observe(root,lease=None):
 try:return settled(root,lease)
 except RuntimeError as error:
  file=Path(sys.argv[2])/('occupancy-at-refusal-'+str(os.getpid())+'.json')
  file.write_text(json.dumps({'rootKind':Path(root).name,'pid':os.getpid(),'allowedFd':lease.fileno() if lease else None,'holders':getattr(error,'holders',None)}));os.chmod(file,0o600)
  raise
m.settled=observe
def crash(path,value,**kwargs):
 original(path,value,**kwargs)
 if Path(path)==Path(sys.argv[2])/'source-engine/handoff-retired.json':os._exit(73)
m.durable_json=crash
m.activate_idle_product(Path(sys.argv[2])/'snapshot',Path(sys.argv[2])/'restored',node=Path(sys.argv[3]))
"""
    result = subprocess.run([sys.executable, "-B", "-c", code, str(ROOT / "scripts/runtime/recovery-handoff.py"),
                             str(evidence), str(node)], cwd=ROOT, env=safe_env(), capture_output=True, timeout=150)
    log = evidence / ("crash-attempt-" + str(len(list(evidence.glob('crash*.log'))) + 1) + ".log")
    with open(log, "xb") as file:
        os.chmod(log, 0o600)
        file.write(result.stdout + result.stderr)
    assert result.returncode == 73, "Crash checkpoint not reached; inspect actual state before resuming"
    for path in [evidence / "source-engine", evidence / "restored/engine"]:
        try:
            ensure_execution_allowed(path)
        except RuntimeError:
            pass
        else:
            raise AssertionError("An original or copy executed during interrupted handoff")
    write_private(evidence / "stage.json", {"stage": "retired_interrupted", "expectedExitCode": 73,
                                           "originalDisabled": True, "copyDisabled": True})


def finish(node, evidence):
    handoff = module("recovery_handoff", ROOT / "scripts/runtime/recovery-handoff.py")
    deadline = time.monotonic() + 5
    # The interrupted parent's two Node guards finish on pipe EOF. Probe only
    # their leases, never repeat a transfer while its owner might still live.
    probe = "import {acquireWorkspaceLease} from './scripts/runtime/workspace-lease.mjs';for(const root of process.argv.slice(1)){const lease=acquireWorkspaceLease(root);lease.close();}"
    while True:
        result = subprocess.run([str(node), "--input-type=module", "-e", probe,
            str(evidence / "source-workspace"), str(evidence / "restored/workspace")], cwd=ROOT, env=safe_env(), capture_output=True, timeout=10)
        if result.returncode == 0:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Interrupted maintenance is still releasing; do not signal it")
        time.sleep(0.05)
    report = handoff.activate_idle_product(evidence / "snapshot", evidence / "restored", node=node)
    assert report["status"] == "completed" and report["originalBindingsVerified"] == 1
    assert not any(report[key] for key in ["bindingsChanged", "originalQueueStarted", "workerStarted", "taskReplay", "modelCalls"])
    write_private(evidence / "handoff.json", report)
    entry = evidence / "restored/核对并启用副本.command"
    if entry.exists():
        confirmed = subprocess.run(["/bin/zsh", str(entry)], input="接续\n", cwd=ROOT,
                                   env=safe_env(), capture_output=True, text=True, encoding="utf-8", timeout=150)
        with open(evidence / "entry-confirmed.log", "x", encoding="utf-8") as log:
            os.chmod(log.name, 0o600)
            log.write(confirmed.stdout + confirmed.stderr)
        assert confirmed.returncode == 0 and "已经核对完成" in confirmed.stdout
        assert read_private(evidence / "restored/handoff-complete.json")["id"] == report["handoffId"]
        repeated = {"status": "already_completed", "handoffId": report["handoffId"],
                    "viaGeneratedEntry": True, "modelCalls": 0, "taskReplay": False}
    else:
        repeated = handoff.activate_idle_product(evidence / "snapshot", evidence / "restored", node=node)
    assert repeated["status"] == "already_completed" and repeated["handoffId"] == report["handoffId"]
    write_private(evidence / "same-intent.json", repeated)
    write_private(evidence / "stage.json", {"stage": "activated", "handoffId": report["handoffId"]})


def verify_runtime(node, evidence):
    restored = evidence / "restored"
    saved, infra, data = configuration(restored / "engine")
    relay = read_private(evidence / "baseline.json").get("relayMode", False)
    assert saved["providerConfigured"] is relay
    task = read_private(evidence / "baseline.json")["taskId"]
    connection = read_private(restored / "workspace/connection.json")
    expected = read_private(evidence / "baseline.json")["engineTables"]
    if relay:
        from relay_recovery import workspace_relay_endpoint
        assert data["model_relay_endpoint"] == workspace_relay_endpoint(restored / "workspace")
        assert data["model_relay_endpoint"] != read_private(evidence / "snapshot/engine/engine/bootstrap.json")["model_relay_endpoint"]
    before_code = "import {inspectDatabase} from './scripts/runtime/recovery.mjs';console.log(JSON.stringify(inspectDatabase(process.argv[1]+'/workspace.sqlite')));"
    before = node_call(node, before_code, [restored / "workspace"], evidence / "workspace-before.json")
    token = (restored / "engine/engine/access-token").read_text().strip()
    delivery = read_private(evidence / "bindings.json")["delivery"]

    def check():
        request = urllib.request.Request(f'http://127.0.0.1:{data["api_port"]}/api/executions/{task}', headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=5) as response:
            row = json.load(response)
        assert row["id"] == task and row["status"] == "completed"
        if relay:
            body = json.dumps({"protocolVersion": "synplex.workspace/1.0.0", "scope": connection["scope"]}).encode()
            headers = {"Content-Type": "application/json", "Authorization": "Bearer " + Path(connection["uiTokenFile"]).read_text().strip()}
            request = urllib.request.Request(connection["endpoint"] + "/api/v1/ui_models", data=body, headers=headers)
            with urllib.request.urlopen(request, timeout=5) as response:
                models = json.load(response)["connections"]
            assert len(models) == 1 and models[0]["models"][0]["pricing"]["source"] == "fixture-price"
            assert "synthetic-private-restore-key" not in json.dumps(models)
            request = urllib.request.Request(connection["endpoint"] + "/api/v1/ui_chat_list", data=json.dumps({"protocolVersion": "synplex.workspace/1.0.0", "scope": connection["scope"], "cursor": None}).encode(), headers=headers)
            with urllib.request.urlopen(request, timeout=5) as response:
                assert len(json.load(response)["items"]) == 1
        body = json.dumps({"protocolVersion": "synplex.workspace/1.0.0", "scope": connection["scope"],
                           "resultId": delivery["resultId"], "artifactId": delivery["artifactId"]}).encode()
        request = urllib.request.Request(connection["endpoint"] + "/api/v1/artifact_file", data=body,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + Path(connection["uiTokenFile"]).read_text().strip()})
        with urllib.request.urlopen(request, timeout=5) as response:
            raw = response.read()
        assert hashlib.sha256(raw).hexdigest() == delivery["sha256"] and len(raw) == delivery["byteLength"]

    command = [str(node), str(ROOT / "scripts/runtime/open.mjs"), "--no-open"]
    # The launcher selects its own recovered data; don't touch the live preview.
    previous = os.environ.get("SYNPLEX_WORKSPACE_DATA_DIR")
    os.environ["SYNPLEX_WORKSPACE_DATA_DIR"] = str(restored / "workspace")
    try:
        with open(evidence / "restored-supervisor.log", "xb") as log:
            os.chmod(log.name, 0o600)
            child = subprocess.Popen(command, cwd=ROOT, env={**safe_env(), "SYNPLEX_WORKSPACE_DATA_DIR": str(restored / "workspace"), "SYNPLEX_TEST_NO_MODELS": "1"},
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                ready(child, connection["endpoint"] + "/health")
                check()
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=30)
    finally:
        if previous is None:
            os.environ.pop("SYNPLEX_WORKSPACE_DATA_DIR", None)
        else:
            os.environ["SYNPLEX_WORKSPACE_DATA_DIR"] = previous
    after = node_call(node, before_code, [restored / "workspace"], evidence / "workspace-after.json")
    assert before == after
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        assert database_state(data) == expected
    finally:
        owned.close()
    for name in ["engine", "workspace"]:
        source = evidence / ("source-" + name)
        if name == "engine":
            try:
                ensure_execution_allowed(source)
            except RuntimeError as error:
                assert "原实例已停止使用" in str(error)
            else:
                raise AssertionError("Original re-enabled after target shutdown")
        else:
            rejected = subprocess.run([str(node), "--input-type=module", "-e", "import {assertWorkspaceAdmission} from './scripts/runtime/handoff-state.mjs';assertWorkspaceAdmission(process.argv[1]);", str(source)],
                                     cwd=ROOT, env=safe_env(), capture_output=True, timeout=10)
            assert rejected.returncode != 0
    report = {"status": "passed", "realPostgreSQLAndValkey": True, "realRecoveredApiAndWorkerStartup": True,
              "syntheticTerminalTask": task, "originalTaskIdentityPreserved": True, "allDatabaseTablesUnchanged": True,
              "workspaceFingerprintUnchanged": True, "sameIntentResumedAfterProcessExit": True,
              "originalArtifactDownloadedFromRecoveredHttp": True,
              "originalStillRefusedAfterTargetShutdown": True, "relayEndpointRemapped": relay, "encryptedModelsAndChatPreserved": relay, "modelCalls": 0, "taskExecutions": 0,
              "limitation": "Idle first joint recovery only; no pending queue, unknown operation, in-flight recovery, cross-version migration or model-quality result"}
    write_private(evidence / "result.json", report)
    write_private(evidence / "stage.json", {"stage": "passed"})
    return report


def run(backend, pg_bin, valkey, node, evidence, *, resume=False, relay=False):
    if not resume:
        if evidence.exists():
            raise RuntimeError("Evidence exists; inspect actual stage and explicitly resume, never repeat setup")
        evidence.mkdir(parents=True, mode=0o700)
        prepare(backend, pg_bin, valkey, node, evidence, relay=relay)
    stage = read_private(evidence / "stage.json")["stage"]
    if stage == "prepared":
        backup_restore(backend, pg_bin, valkey, node, evidence)
        stage = "restored"
    if stage == "restored":
        crash_after_retirement(node, evidence)
        stage = "retired_interrupted"
    if stage == "retired_interrupted":
        finish(node, evidence)
        stage = "activated"
    if stage == "activated":
        return verify_runtime(node, evidence)
    raise RuntimeError("This evidence is already complete or has an unrecognised stage; inspect it, never replay")


if __name__ == "__main__":
    print(json.dumps(run(*[Path(p).resolve() for p in sys.argv[1:6]], resume="--resume" in sys.argv[6:], relay="--relay" in sys.argv[6:])))
