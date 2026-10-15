"""One offline original/snapshot comparison, then deliberate source progress.

The task rows are bookkeeping fixtures. No engine API, queue, worker or model
starts. A successful existing evidence directory must never be replayed.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

import psycopg

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from engine_runtime import setup, configuration
from engine_recovery import product_snapshot, database_state, verify_product
from local_runner import database_connection
from private_infrastructure import OwnedInfrastructure, safe_env, write_private

spec = importlib.util.spec_from_file_location("recovery_origin", ROOT / "scripts/runtime/recovery-origin.py")
origin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(origin)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(backend, pg_bin, valkey, node, evidence, *, resume_before_backup=False):
    if evidence.exists() and not resume_before_backup:
        raise RuntimeError("Inspect interrupted evidence; do not repeat setup or mutations")
    if not resume_before_backup:
        evidence.mkdir(parents=True, mode=0o700)
    engine, workspace, snapshot = [evidence / name for name in ["engine", "workspace", "snapshot"]]
    ports = [port() for _ in range(3)]
    assert len(set(ports)) == 3
    if resume_before_backup:
        assert not snapshot.exists() and not (evidence / "result.json").exists()
    else:
        setup(engine, backend, pg_bin, valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    _, infra, data = configuration(engine)
    artifact = engine / "engine/artifacts/origin-check.md"
    if resume_before_backup:
        assert artifact.read_text() == "备份时的成果"
        ports = [data["api_port"], data["redis_port"], infra["port"]]
    else:
        artifact.parent.mkdir(mode=0o700, exist_ok=True)
        artifact.write_text("备份时的成果")
        os.chmod(artifact, 0o600)
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data, data["database"])) as db:
            if resume_before_backup:
                db.execute("SET TRANSACTION READ ONLY")
                assert db.execute("SELECT * FROM original_progress ORDER BY id").fetchall() == [(1, "备份时的记录")]
                assert [r["table"] for r in database_state(data)] == ["original_progress"]
            else:
                db.execute("CREATE TABLE original_progress (id INTEGER PRIMARY KEY, note TEXT)")
                db.execute("INSERT INTO original_progress VALUES (1,'备份时的记录')")
    finally:
        owned.close()
    seed = """
import {seedRecoveryWorkspace} from './scripts/testing/recovery-fixture.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {WorkspaceRepository} from './services/workspace/repository.mjs';
const [workspace,engine]=process.argv.slice(1),data=JSON.parse(readFileSync(engine+'/engine/bootstrap.json'));
seedRecoveryWorkspace(workspace,engine,data,{});
const connection=JSON.parse(readFileSync(workspace+'/connection.json')),repository=new WorkspaceRepository({dataDir:workspace});
try{const writer=repository.createCredential({ownerId:'fixture-owner',actorId:'human-writer',scope:connection.scope,kind:'ui',capabilities:['read_memory','write_memory']});writeFileSync(connection.uiTokenFile,writer.token,{mode:0o600});}finally{repository.close();}
"""
    if resume_before_backup:
        check = "import {inspectDatabase} from './scripts/runtime/recovery.mjs';const r=inspectDatabase(process.argv[1]+'/workspace.sqlite');if(r.counts.length||r.unresolved)throw Error('Source already progressed');console.log(JSON.stringify(r));"
        checked = subprocess.run([str(node), "--input-type=module", "-e", check, str(workspace)], cwd=ROOT, env=safe_env(), capture_output=True, timeout=30)
        assert checked.returncode == 0, "Source already progressed; do not replay"
        write_private(evidence / "resumed-before-backup.json", {"sourceRowsVerified": True, "workspaceEmpty": True, "setupRepeated": False, "seedRepeated": False})
    else:
        seeded = subprocess.run([str(node), "--input-type=module", "-e", seed, str(workspace), str(engine)],
                                cwd=ROOT, env=safe_env(), capture_output=True, timeout=30)
        (evidence / "seed.log").write_bytes(seeded.stdout + seeded.stderr)
        os.chmod(evidence / "seed.log", 0o600)
        assert seeded.returncode == 0, "Inspect seed log before continuing"
    product_snapshot(workspace, engine, snapshot, node=node)
    first = origin.compare_original(snapshot, node=node)
    assert first["state"] == "unchanged_at_check"
    assert first["canEnableExecution"] is False
    write_private(evidence / "before-progress.json", first)
    # An open source file is enough to refuse before starting infrastructure.
    actual_start = origin.OwnedInfrastructure

    class MustNotStart:
        def __init__(self, *args):
            raise AssertionError("An occupied source must never start PostgreSQL")

    origin.OwnedInfrastructure = MustNotStart
    try:
        with artifact.open("r"):
            try:
                origin.compare_original(snapshot, node=node)
            except RuntimeError as error:
                assert "使用" in str(error)
            else:
                raise AssertionError("Occupied source accepted")
    finally:
        origin.OwnedInfrastructure = actual_start
    # Actual post-snapshot progress remains in the original. Never roll it back
    # to manufacture a match with an obsolete snapshot.
    artifact.write_text("备份后新增的成果，必须保留")
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data, data["database"])) as db:
            db.execute("INSERT INTO original_progress VALUES (2,'备份后原实例的新进展')")
        advanced = database_state(data)
    finally:
        owned.close()
    append = """
import {WorkspaceRepository} from './services/workspace/repository.mjs';
import {readFileSync} from 'node:fs';
const directory=process.argv[1],connection=JSON.parse(readFileSync(directory+'/connection.json'));
const repository=new WorkspaceRepository({dataDir:directory});
try{const auth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim()),scope=connection.scope;
 repository.saveBlob(auth,scope,{bytes:Buffer.from('备份后原工作台新增资料'),format:'text/plain'},{requestId:'post-snapshot-original',expectedStateRevision:repository.state(auth,scope).stateRevision});
}finally{repository.close();}
"""
    added = subprocess.run([str(node), "--input-type=module", "-e", append, str(workspace)],
                           cwd=ROOT, env=safe_env(), capture_output=True, timeout=30)
    (evidence / "append.log").write_bytes(added.stdout + added.stderr)
    os.chmod(evidence / "append.log", 0o600)
    assert added.returncode == 0, "Inspect append log; never repeat the insert"
    report = origin.compare_original(snapshot, node=node)
    assert report["state"] == "original_changed"
    assert report["workspace"]["databaseUnchanged"] is False
    assert report["workspace"]["filesUnchanged"] is True
    assert report["engine"] == {"databaseUnchanged": False, "filesUnchanged": False}
    assert not any(report[name] for name in ["modelCalls", "taskReplay", "workerStarted", "queueStarted", "executorsEnabled", "canEnableExecution"])
    assert all(secret not in json.dumps(report) for secret in [data["jwt_secret"], data["redis_password"], data["database_password"]])
    write_private(evidence / "after-progress.json", report)
    # The same private child is started once more only to verify that inspection
    # preserved every new row; this is not a repeated product task.
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        assert database_state(data) == advanced
    finally:
        owned.close()
    assert artifact.read_text() == "备份后新增的成果，必须保留"
    verify_product(snapshot, node=node)
    for number in ports:
        with socket.socket() as sock:
            assert sock.connect_ex(("127.0.0.1", number)) != 0
    result = {"status": "passed", "unchangedObserved": True, "occupiedOriginalRefusedBeforeStart": True,
              "postSnapshotWorkspaceDatabaseDetected": True, "postSnapshotEngineDatabaseAndFileDetected": True,
              "originalProgressPreserved": True, "snapshotPreserved": True, "canEnableExecution": False,
              "modelCalls": 0, "taskExecutions": 0,
              "limitation": "Stopped original only; no live reconciliation, execution authority transfer, worker recovery or cross-version migration"}
    write_private(evidence / "result.json", result)
    return result


if __name__ == "__main__":
    print(json.dumps(run(*[Path(p).resolve() for p in sys.argv[1:6]], resume_before_backup="--resume-before-backup" in sys.argv[6:])))
