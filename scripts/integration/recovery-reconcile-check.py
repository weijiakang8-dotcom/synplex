"""One free real-PG joint-restore identity check; bookkeeping fixtures only.

No planner, API, queue, worker or provider starts. Preserve evidence on failure;
never re-run setup in an existing evidence directory.
"""
import json
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import uuid

import psycopg

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from engine_runtime import setup, configuration, ensure_execution_allowed
from engine_recovery import product_snapshot, product_restore, database_state
from engine_reconcile import inspect_product
from local_runner import database_connection
from private_infrastructure import OwnedInfrastructure, read_private, safe_env, write_private


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(backend, pg_bin, valkey, node, evidence, *, with_origin=False):
    if evidence.exists():
        raise RuntimeError("Use a fresh evidence directory; inspect an interrupted run first")
    evidence.mkdir(mode=0o700, parents=True)
    original, workspace = evidence / "original-engine", evidence / "workspace"
    ports = [port() for _ in range(3)]
    assert len(set(ports)) == 3
    setup(original, backend, pg_bin, valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    _, infra, data = configuration(original)
    # Deterministic records for identity/transaction checks. These are not model
    # task-completion results and must never be counted as business success.
    tasks = {name: str(uuid.uuid4()) for name in ["completed", "pending", "wrong_owner", "missing", "foreign"]}
    tasks["unidentified"] = None
    for name in ['receipt_found','receipt_wrong_attempt','receipt_wrong_task']:
        tasks[name] = None
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data, data["database"])) as db:
            db.execute("CREATE TABLE workflows (id UUID PRIMARY KEY, organization_id UUID, created_by TEXT)")
            db.execute("CREATE TABLE executions (id UUID PRIMARY KEY, workflow_id UUID, organization_id UUID, user_id UUID, status TEXT, correlation_id UUID)")
            db.execute("CREATE TABLE outbox_events (id UUID PRIMARY KEY, published_at TIMESTAMPTZ)")
            db.execute("INSERT INTO workflows VALUES (%s,%s,%s)", (data["workflow_id"], data["organization_id"], data["user_id"]))
            for name in ["completed", "pending", "wrong_owner"]:
                owner = str(uuid.uuid4()) if name == "wrong_owner" else data["user_id"]
                db.execute("INSERT INTO executions (id,workflow_id,organization_id,user_id,status) VALUES (%s,%s,%s,%s,%s)",
                           (tasks[name], data["workflow_id"], data["organization_id"], owner,
                            "completed" if name != "pending" else "pending"))
            db.execute("INSERT INTO outbox_events VALUES (%s,NULL)", (str(uuid.uuid4()),))
    finally:
        owned.close()
    write_private(original / "engine/access-token", {"fixture": "not-a-valid-api-token"})
    write_private(evidence / "task-fixtures.json", tasks)
    seed = """
import {readFileSync,writeFileSync} from 'node:fs';
import {seedRecoveryWorkspace} from './scripts/testing/recovery-fixture.mjs';
const [workspace,engine,file]=process.argv.slice(1),data=JSON.parse(readFileSync(engine+'/engine/bootstrap.json'));
const ids=seedRecoveryWorkspace(workspace,engine,data,JSON.parse(readFileSync(file)));
writeFileSync(file+'.bindings',JSON.stringify(ids),{mode:0o600,flag:'wx'});
"""
    seeded = subprocess.run([str(node), "--input-type=module", "-e", seed, str(workspace), str(original),
                             str(evidence / "task-fixtures.json")], cwd=ROOT, env=safe_env(), capture_output=True, timeout=20)
    (evidence / "seed.log").write_bytes(seeded.stdout + seeded.stderr)
    os.chmod(evidence / "seed.log", 0o600)
    assert seeded.returncode == 0, "Inspect private seed log; do not repeat setup"
    ids = read_private(evidence / 'task-fixtures.json.bindings')
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data, data['database'])) as db:
            from submission_delivery import CREATE_TABLE
            db.execute(CREATE_TABLE)
            for name in ['receipt_found','receipt_wrong_attempt','receipt_wrong_task']:
                binding, task_id = ids[name], str(uuid.uuid4())
                correlation = str(uuid.uuid4()) if name == 'receipt_wrong_task' else binding['operationId']
                db.execute('INSERT INTO executions VALUES (%s,%s,%s,%s,%s,%s)',
                           (task_id,data['workflow_id'],data['organization_id'],data['user_id'],'completed',correlation))
                attempt = str(uuid.uuid4()) if name == 'receipt_wrong_attempt' else binding['attemptId']
                db.execute('INSERT INTO synplex_execution_submissions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                           (binding['operationId'],attempt,binding['packetHash'],binding['payloadHash'],
                            data['organization_id'],data['user_id'],data['workflow_id'],task_id,'synthetic bookkeeping fixture'))
        before = database_state(data)
    finally:
        owned.close()
    return finish(backend, pg_bin, valkey, node, evidence, before, with_origin=with_origin)


def finish(backend, pg_bin, valkey, node, evidence, before, *, with_origin):
    original, workspace = evidence / 'original-engine', evidence / 'workspace'
    _, infra, data = configuration(original)
    ids = read_private(evidence / 'task-fixtures.json.bindings')
    backup, restored = evidence / "snapshot", evidence / "restored"
    product_snapshot(workspace, original, backup, node=node)
    if with_origin:
        spec = importlib.util.spec_from_file_location('recovery_origin', ROOT / 'scripts/runtime/recovery-origin.py')
        origin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(origin)
        original_report = origin.compare_original(backup, node=node)
        assert original_report['state'] == 'unchanged_at_check'
        assert original_report['canEnableExecution'] is False
        write_private(evidence / 'original-inspection.json', original_report)
    new_ports = [port() for _ in range(4)]
    assert len(set(new_ports)) == 4
    product_restore(backup, restored, node=node, workspace_port=new_ports[3], backend=backend, pg_bin=pg_bin,
                    valkey=valkey, api_port=new_ports[0], redis_port=new_ports[1], database_port=new_ports[2])
    report = inspect_product(backup, restored, node=node)
    write_private(evidence / "inspection.json", report)
    return finish_inspection(evidence, node, before, report)


def finish_inspection(evidence, node, before, report):
    assert not (evidence / 'result.json').exists()
    backup, restored = evidence / 'snapshot', evidence / 'restored'
    ids = read_private(evidence / 'task-fixtures.json.bindings')
    _, _, data = configuration(evidence / 'original-engine')
    saved, infra, restored_data = configuration(restored / 'engine')
    new_ports = [saved['apiPort'], saved['redisPort'], saved['databasePort'],
                 int(read_private(restored / 'workspace/connection.json')['endpoint'].rsplit(':', 1)[1])]
    by_operation = {t['operationId']:t for t in report['tasks']}
    row = lambda name:by_operation[ids[name]['operationId']]
    assert row('completed')['state'] == 'original_task_verified'
    assert row('completed')['engineStatus'] == 'completed'
    assert row('pending')['engineStatus'] == 'pending'
    assert row('wrong_owner')['state'] == 'task_identity_mismatch'
    assert row('missing')['state'] == 'task_missing'
    assert row('foreign')['state'] == 'other_connection'
    assert row('unidentified')['state'] == 'submission_receipt_missing'
    assert row('receipt_found')['state'] == 'original_task_verified'
    assert row('receipt_found')['originalTaskId'] is None and row('receipt_found')['taskId']
    assert row('receipt_found')['identifiedBy'] == 'original_submission_receipt'
    assert row('receipt_wrong_attempt')['state'] == 'submission_identity_mismatch'
    assert row('receipt_wrong_task')['state'] == 'task_identity_mismatch'
    assert report["pendingExecutions"] == report["unpublishedEvents"] == 1
    assert report["unresolvedBindings"] == 6
    assert report["canEnableExecution"] is False
    assert not any(report[k] for k in ["queueStarted", "workerStarted", "executorsEnabled", "bindingsChanged", "modelCalls"])
    assert all(secret not in json.dumps(report) for secret in [data["jwt_secret"], data["redis_password"], data["database_password"]])
    try:
        ensure_execution_allowed(restored / "engine")
    except RuntimeError:
        pass
    else:
        raise AssertionError("Read-only inspection enabled a restored engine")
    # Changed identity is rejected before any database child or task query starts.
    state_path = restored / "engine/engine/bootstrap.json"
    exact = read_private(state_path)
    write_private(state_path, {**exact, "user_id": str(uuid.uuid4())})
    try:
        inspect_product(backup, restored, node=node)
    except RuntimeError as error:
        assert "身份" in str(error)
    else:
        raise AssertionError("Changed restored identity accepted")
    finally:
        write_private(state_path, exact)
    # The accepted inspection already compared every table before AND after;
    # do not start PostgreSQL a third time to repeat the same assertion.
    assert read_private(backup / "engine/engine-snapshot.json")["database"] == before
    for number in new_ports:
        with socket.socket() as s:
            assert s.connect_ex(("127.0.0.1", number)) != 0
    result = {"status": "passed", "bookkeepingFixtures": 9, "originalTasksVerified": 3,
              "noIdOriginalIdentifiedFromReceipt":1,"unresolvedKept": 6, "everyTableUnchanged": True, "newModelCalls": 0,
              "taskReplay": False, "executionStillDisabled": True,
              "limitation": "Exact offline snapshot only; original live instance divergence and execution re-enable not validated"}
    if (evidence / 'original-inspection.json').exists():
        assert read_private(evidence / 'original-inspection.json')['state'] == 'unchanged_at_check'
        result['originalUnchangedInspectedUnderWorkspaceLease'] = True
    write_private(evidence / "result.json", result)
    return result


def resume_before_backup(backend, pg_bin, valkey, node, evidence, *, with_origin):
    """Read-verify the interrupted synthetic seed, then run ONLY missing phases."""
    assert evidence.is_dir() and not any((evidence / name).exists() for name in ['restored','result.json'])
    original = evidence / 'original-engine'
    _, infra, data = configuration(original)
    assert Path(data['backend']).resolve() == backend
    tasks = read_private(evidence / 'task-fixtures.json')
    ids = read_private(evidence / 'task-fixtures.json.bindings')
    assert set(tasks) == set(ids) and len(tasks) == 9
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data, data['database'])) as db:
            db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            assert db.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall() == [(n,) for n in ['executions','outbox_events','synplex_execution_submissions','workflows']]
            assert tuple(map(str, db.execute('SELECT id,organization_id,created_by FROM workflows').fetchone())) == (data['workflow_id'],data['organization_id'],data['user_id'])
            rows = db.execute('SELECT id,workflow_id,organization_id,user_id,status,correlation_id FROM executions').fetchall()
            assert len(rows) == 6
            by_id = {str(r[0]): r for r in rows}
            for name in ['completed','pending','wrong_owner']:
                row = by_id[tasks[name]]
                assert tuple(map(str,row[1:3])) == (data['workflow_id'],data['organization_id'])
                assert (str(row[3]) != data['user_id']) is (name == 'wrong_owner')
                assert row[4] == ('pending' if name == 'pending' else 'completed') and row[5] is None
            receipts = db.execute('SELECT operation_id,attempt_id,packet_hash,payload_hash,organization_id,user_id,workflow_id,execution_id FROM synplex_execution_submissions').fetchall()
            assert len(receipts) == 3
            by_operation = {str(r[0]): r for r in receipts}
            for name in ['receipt_found','receipt_wrong_attempt','receipt_wrong_task']:
                binding = ids[name]
                receipt = by_operation[binding['operationId']]
                assert tuple(map(str,receipt[2:7])) == (binding['packetHash'],binding['payloadHash'],data['organization_id'],data['user_id'],data['workflow_id'])
                assert (str(receipt[1]) != binding['attemptId']) is (name == 'receipt_wrong_attempt')
                row = by_id[str(receipt[7])]
                assert tuple(map(str,row[1:5])) == (data['workflow_id'],data['organization_id'],data['user_id'],'completed')
                assert (str(row[5]) != binding['operationId']) is (name == 'receipt_wrong_task')
            assert db.execute('SELECT count(*),count(published_at) FROM outbox_events').fetchone() == (1,0)
        before = database_state(data)
    finally:
        owned.close()
    previous = evidence / 'resumed-before-backup.json'
    if previous.exists():
        assert read_private(previous)['database'] == before
    else:
        write_private(previous, {'seedVerifiedReadOnly':True,'setupRepeated':False,'seedRepeated':False,'database':before})
    incomplete = evidence / 'snapshot'
    if incomplete.exists():
        assert {p.name for p in incomplete.iterdir()} == {'product-incomplete.json'}
        assert read_private(incomplete / 'product-incomplete.json') == {'workspace':str((evidence / 'workspace').resolve()),'engine':str(original.resolve())}
        incomplete.rename(evidence / ('snapshot-refused-before-workspace-' + str(uuid.uuid4())))
    return finish(backend,pg_bin,valkey,node,evidence,before,with_origin=with_origin)


if __name__ == "__main__":
    if '--resume-after-inspection' in sys.argv[6:]:
        evidence = Path(sys.argv[5]).resolve()
        print(json.dumps(finish_inspection(evidence,Path(sys.argv[4]).resolve(),
                         read_private(evidence / 'resumed-before-backup.json')['database'],
                         read_private(evidence / 'inspection.json'))))
    else:
        action = resume_before_backup if '--resume-before-backup' in sys.argv[6:] else run
        print(json.dumps(action(*[Path(p).resolve() for p in sys.argv[1:6]], with_origin='--with-origin' in sys.argv[6:])))
