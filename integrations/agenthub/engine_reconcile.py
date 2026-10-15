"""Inspect an exact, disabled product restoration without replaying any work.

Starts only this restored cluster's temporary PostgreSQL process. No API, model,
queue or worker starts; a verified identity is not permission to enable either
copy. The original engine can have advanced since the snapshot.
"""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import subprocess
import uuid

from engine_runtime import configuration
from engine_recovery import database_state, files, settled, verify_product
from local_runner import database_connection
from private_infrastructure import OwnedInfrastructure, read_private, safe_env
from workspace_maintenance import workspace_maintenance


def restored_identity(source, target, *, node, handoff=None):
    manifest = verify_product(source, node=node)
    record = read_private(target / "product-recovery.json")
    if (record.get("format") != "synplex.product-restoration/1"
            or not (record.get("executorsEnabled") is False or handoff and record.get("executorsEnabled") is True and record.get("handoff") == handoff)
            or record.get("remoteIdentitiesRemapped") is not False
            or Path(record.get("snapshot", "")).resolve() != source
            or (target / "restore-incomplete.json").exists()):
        raise RuntimeError("这不是尚未启用的完整联合恢复目录，未核对或改写任务。")
    engine = target / "engine"
    saved, infra, data = configuration(engine)
    disabled = read_private(engine / "recovery.json")
    if (disabled.get("format") != "synplex.engine-restoration/1"
            or not (disabled.get("executorsEnabled") is False or handoff and disabled.get("executorsEnabled") is True and disabled.get("handoff") == handoff)
            or Path(disabled.get("snapshot", "")).resolve() != source / "engine"):
        raise RuntimeError("恢复引擎已启用或来源不同，不能按原快照核对。")
    original = read_private(source / "engine/engine/bootstrap.json")
    changed = {"backend", "api_port", "redis_port", "database_port", "database_user",
               "database_password", "infrastructure_id", "database_root"}
    strip = lambda d: {k: v for k, v in d.items() if k not in changed}
    old_start = read_private(source / "engine/original-startup.json")
    if (strip(data) != strip(original) or saved["sourceIdentity"] != old_start["sourceIdentity"]
            or saved["lockSha256"] != old_start["lockSha256"]):
        raise RuntimeError("恢复引擎的原身份或执行版本不同，未映射任务。")
    # All engine files other than the two explicitly rewritten connection files
    # must still be exact, including artifacts, access token and persisted queue.
    kept = lambda root: [r for r in files(root) if r["path"] not in {"bootstrap.json", "valkey.conf"}]
    if kept(engine / "engine") != kept(source / "engine/engine"):
        raise RuntimeError("恢复引擎的原文件或队列已有变化，先核对变化，不能自动接续。")
    return manifest, infra, data


def workspace_bindings(source, target, manifest, *, node, handoff_intent=None):
    tool = Path(__file__).resolve().parents[2] / "scripts/runtime/recovery-bindings.mjs"
    command = [str(node.resolve()), str(tool), str(source / "workspace"),
                             str(target / "workspace"), manifest["engine"],
                             str(source / "engine/engine/bootstrap.json")]
    if handoff_intent:
        command += ["--handoff-intent", str(handoff_intent)]
    result = subprocess.run(command,
                            env=safe_env(), capture_output=True, timeout=120)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        raise RuntimeError("工作台的原任务连接未通过核对；没有修改连接或发送任务。")
    report = json.loads(result.stdout)
    if report.get("format") != "synplex.recovery-bindings/1":
        raise RuntimeError("原任务核对结果格式无效，执行工具保持停用。")
    return report


def find_original_submission(connection, data, binding):
    """A proof from the same snapshot; never bind, schedule or infer from text."""
    row = dict(binding)
    receipt = connection.execute(
        "SELECT execution_id,attempt_id,packet_hash,payload_hash,organization_id,user_id,workflow_id "
        "FROM synplex_execution_submissions WHERE operation_id=%s", (row['operationId'],)).fetchone()
    if receipt is None:
        return {**row, 'state': 'submission_receipt_missing'}
    expected = (row['attemptId'], row['packetHash'], row['payloadHash'],
                data['organization_id'], data['user_id'], data['workflow_id'])
    try:
        task_id = str(uuid.UUID(str(receipt[0])))
    except (ValueError, TypeError, AttributeError):
        return {**row, 'state': 'submission_identity_mismatch'}
    if tuple(map(str, receipt[1:])) != expected:
        return {**row, 'state': 'submission_identity_mismatch'}
    return {**row, 'taskId': task_id, 'originalTaskId': None,
            'identifiedBy': 'original_submission_receipt', 'state': 'ready_to_inspect'}


def inspect_tasks(connection, data, bindings, *, submission_receipts=False):
    rows = []
    for binding in bindings:
        row = dict(binding)
        if row['state'] == 'ready_to_find_original':
            row = find_original_submission(connection, data, row) if submission_receipts else {
                **row, 'state': 'unidentified_submission'}
        if row["state"] == "ready_to_inspect":
            found = row.get('identifiedBy') == 'original_submission_receipt'
            actual = connection.execute(
                "SELECT e.status, e.workflow_id, e.organization_id, e.user_id, "
                "w.organization_id, w.created_by" + (", e.correlation_id" if found else "") + " FROM executions e "
                "LEFT JOIN workflows w ON w.id=e.workflow_id WHERE e.id=%s",
                (row["taskId"],)).fetchone()
            if actual is None:
                row["state"] = "task_missing"
            elif (tuple(map(str, actual[1:6])) != (data["workflow_id"], data["organization_id"],
                    data["user_id"], data["organization_id"], data["user_id"])
                    or found and str(actual[6]) != row['operationId']):
                row["state"] = "task_identity_mismatch"
            else:
                row.update(state="original_task_verified", engineStatus=actual[0])
        rows.append(row)
    seen = {}
    for row in rows:
        if row['state'] == 'original_task_verified':
            if row['taskId'] in seen:
                row['state'] = seen[row['taskId']]['state'] = 'duplicate_remote_identity'
            else:
                seen[row['taskId']] = row
    return rows


def inspect_database(data, bindings):
    import psycopg
    with psycopg.connect(**database_connection(data, data["database"])) as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        db.execute("SET LOCAL statement_timeout='10s'")
        marker = db.execute("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()").fetchone()
        if not marker or marker[0] != "synplex-isolated-engine:" + data["id"]:
            raise RuntimeError("数据库不属于这份恢复引擎，未核对任务。")
        tables = {r[0] for r in db.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")}
        required = {"executions", "workflows", "outbox_events"}
        if not required.issubset(tables):
            tasks = [{**b, "state": "engine_tables_missing"} if b["state"] in {'ready_to_inspect','ready_to_find_original'} else b for b in bindings]
            return {"tasks": tasks, "missingTables": sorted(required - tables),
                    "pendingExecutions": None, "unpublishedEvents": None}
        tasks = inspect_tasks(db, data, bindings, submission_receipts='synplex_execution_submissions' in tables)
        pending = db.execute("SELECT count(*) FROM executions WHERE status IN ('pending','running','waiting_for_approval')").fetchone()[0]
        unpublished = db.execute("SELECT count(*) FROM outbox_events WHERE published_at IS NULL").fetchone()[0]
        return {"tasks": tasks, "missingTables": [], "pendingExecutions": pending,
                "unpublishedEvents": unpublished}


def inspect_product(source, target, *, node):
    source, target = source.resolve(), target.resolve()
    if source == target or source in target.parents or target in source.parents:
        raise RuntimeError("备份和恢复目录必须独立，不能互相嵌套。")
    engine = target / "engine"
    for directory in [engine, engine / "engine", engine / "infrastructure",
                      engine / "infrastructure/postgres", target / "workspace"]:
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError("恢复资料目录不完整或含替身，未启动核对。")
    lock_path = engine / "startup.lock"
    if lock_path.is_symlink() or (lock_path.exists() and not lock_path.is_file()):
        raise RuntimeError("恢复引擎的占用记录无效，未启动核对。")
    settled(engine)
    settled(target / "workspace")
    with open(lock_path, "a+") as lock, workspace_maintenance(node, target / 'workspace') as workspace_guard:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        settled(engine, lock)
        manifest, infra, data = restored_identity(source, target, node=node)
        bindings = workspace_bindings(source, target, manifest, node=node)
        expected = read_private(source / "engine/engine-snapshot.json")["database"]
        owned = OwnedInfrastructure(infra)
        try:
            owned.start_database()
            if database_state(data) != expected:
                raise RuntimeError("恢复数据库已变化，不能把旧快照当作当前结果。")
            result = inspect_database(data, bindings["bindings"])
            if database_state(data) != expected:
                raise RuntimeError("核对期间数据库变化，报告不可用于接续。")
        finally:
            owned.close()
        settled(engine, lock)
        workspace_guard.request('check-unused')
        # Re-check files, config, snapshot and workspace after the database child
        # has closed. No report is accepted across a concurrent mutation.
        restored_identity(source, target, node=node)
        if bindings != workspace_bindings(source, target, manifest, node=node):
            raise RuntimeError("核对期间工作台变化，请保留原资料重新分析。")
    unresolved = sum(t["state"] != "original_task_verified" for t in result["tasks"])
    return {"format": "synplex.product-reconciliation/1", **result,
            "workspaceFingerprint": bindings["workspaceFingerprint"],
            "unresolvedBindings": unresolved, "modelCalls": 0,
            "executorsEnabled": False, "bindingsChanged": False,
            "queueStarted": False, "workerStarted": False, "canEnableExecution": False,
            "notice": "只核对了快照中的原任务；未启动或重新执行。原实例可能已有新进展，须单独核对后才能决定接续。"}
