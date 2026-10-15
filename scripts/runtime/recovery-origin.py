"""Compare an offline original with its joint snapshot; never enable a copy.

No queue, API, worker, model or remote endpoint is used. Only this command's
temporary, identity-checked PostgreSQL child is stopped. An unchanged result is
an observation while locked, not a transfer of execution authority.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from engine_recovery import configuration, database_state, files, settled, verify_product
from private_infrastructure import OwnedInfrastructure, read_private
from workspace_maintenance import workspace_maintenance


def workspace_comparison(workspace_guard, snapshot):
    report = workspace_guard.request('compare-source', snapshot / 'workspace')
    if (report.get("format") != "synplex.workspace-source-comparison/1"
            or set(report) != {"format", "databaseUnchanged", "filesUnchanged", "unchanged"}
            or any(type(report[key]) is not bool for key in report if key != "format")
            or report["unchanged"] != (report["databaseUnchanged"] and report["filesUnchanged"])):
        raise RuntimeError("原资料核对结果不完整，不能作为接续依据。")
    return report


def origin_paths(snapshot, manifest):
    if snapshot.is_symlink():
        raise RuntimeError("请直接选择联合备份目录，不使用替身。")
    roots = []
    for key in ["workspace", "engine"]:
        path = Path(manifest[key])
        if not path.is_absolute() or path.is_symlink() or not path.is_dir() or path.resolve() != path:
            raise RuntimeError("原资料位置已经变化或缺失，先保留现有资料，不能自动接续。")
        if snapshot == path or snapshot in path.parents or path in snapshot.parents:
            raise RuntimeError("原资料和备份必须独立，不能相互嵌套。")
        roots.append(path)
    workspace, engine = roots
    if workspace == engine or workspace in engine.parents or engine in workspace.parents:
        raise RuntimeError("原工作台和执行资料必须分开核对。")
    for directory in [engine / "engine", engine / "infrastructure", engine / "infrastructure/postgres"]:
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError("原执行资料不完整或含替身，未启动核对。")
    return workspace, engine


def compare_original(snapshot, *, node):
    snapshot = snapshot.absolute()
    if snapshot.is_symlink() or not snapshot.is_dir():
        raise RuntimeError("请直接选择完整的联合备份目录，不使用替身。")
    snapshot = snapshot.resolve()
    manifest = verify_product(snapshot, node=node)
    workspace, engine = origin_paths(snapshot, manifest)
    lock_path = engine / "startup.lock"
    if lock_path.is_symlink() or not lock_path.is_file():
        raise RuntimeError("缺少原实例占用记录，不能启动核对。")
    stat = lock_path.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise RuntimeError("原实例占用记录必须仅本人可读写，未启动核对。")
    settled(engine)
    settled(workspace)
    with open(lock_path, "r+") as lock, workspace_maintenance(node, workspace) as workspace_guard:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        settled(engine, lock)
        saved, infra, data = configuration(engine)
        if (saved != read_private(snapshot / "engine/original-startup.json")
                or infra != read_private(snapshot / "engine/original-infrastructure.json")):
            raise RuntimeError("原实例的执行设置已变化，不能借旧备份启动核对。")
        before_workspace = workspace_comparison(workspace_guard, snapshot)
        before_files = files(engine / "engine")
        expected_files = files(snapshot / "engine/engine")
        expected_database = read_private(snapshot / "engine/engine-snapshot.json")["database"]
        owned = OwnedInfrastructure(infra)
        try:
            owned.start_database()
            import psycopg
            from local_runner import database_connection
            with psycopg.connect(**database_connection(data, data["database"])) as connection:
                connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                connection.execute("SET LOCAL statement_timeout='10s'")
                marker = connection.execute("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()").fetchone()
                if not marker or marker[0] != "synplex-isolated-engine:" + data["id"]:
                    raise RuntimeError("原数据库身份不一致，未读取业务资料。")
            before_database = database_state(data)
            if database_state(data) != before_database:
                raise RuntimeError("核对期间原数据库变化，结果不能作为接续依据。")
        finally:
            owned.close()
        settled(engine, lock)
        workspace_guard.request('check-unused')
        if (files(engine / "engine") != before_files
                or configuration(engine) != (saved, infra, data)
                or workspace_comparison(workspace_guard, snapshot) != before_workspace):
            raise RuntimeError("核对期间原资料变化，请保留新内容，不要启用副本。")
        verify_product(snapshot, node=node)
        database_unchanged = before_database == expected_database
        files_unchanged = before_files == expected_files
        unchanged = before_workspace["unchanged"] and database_unchanged and files_unchanged
    return {"format": "synplex.original-snapshot-comparison/1",
            "state": "unchanged_at_check" if unchanged else "original_changed",
            "workspace": before_workspace,
            "engine": {"databaseUnchanged": database_unchanged, "filesUnchanged": files_unchanged},
            "modelCalls": 0, "taskReplay": False, "workerStarted": False, "queueStarted": False,
            "executorsEnabled": False, "canEnableExecution": False,
            "notice": ("原资料在核对时与备份一致；这不代表已经转移执行权，副本仍不能自动接续。" if unchanged else
                       "原资料在备份后已有变化。请保留新内容，重新做联合备份，不要用旧副本覆盖或继续执行。")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--node", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(compare_original(args.snapshot, node=args.node)))
    except Exception:
        print("原实例核对未完成。请保留原资料与备份，确认原实例正常关闭后再核对；没有停止其他程序、启用副本或重新发送任务。", file=sys.stderr)
        sys.exit(1)
