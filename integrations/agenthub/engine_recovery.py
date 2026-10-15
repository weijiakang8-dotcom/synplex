"""Offline private-engine snapshots; new-directory restore never starts a worker.

PostgreSQL uses its native logical archive, not copies of an active data folder.
Only this instance's temporary PostgreSQL child is controlled. Queue bytes and
unfinished jobs are preserved; their presence is not permission to replay them.
"""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from engine_runtime import configuration, verify_environment
from source_identity import verify_source, verify_runtime, SourceCompatibilityError
from local_runner import database_connection, initialize, private_json
from private_infrastructure import OwnedInfrastructure, prepare, read_private, safe_env, write_private, available
from workspace_maintenance import workspace_maintenance


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def files(root):
    result = []
    for file in sorted(root.rglob("*")):
        if file.is_symlink() or not (file.is_file() or file.is_dir()):
            raise RuntimeError("备份中有替身或特殊文件，请保留原目录并核对。")
        if file.is_file():
            result.append({"path": file.relative_to(root).as_posix(), "sha256": digest(file), "bytes": file.stat().st_size})
    return result


def fresh(source, target):
    if source.is_symlink() or target.is_symlink():
        raise RuntimeError("备份与恢复不能使用替身目录。")
    source, target = source.resolve(), target.absolute()
    if target.exists() or source == target or source in target.parents or target in source.parents:
        raise RuntimeError("请选择原目录之外全新的目标目录，不覆盖已有资料。")
    # Resolve existing parents before accepting a target through a symlink.
    existing = target
    while not existing.exists():
        existing = existing.parent
    canonical = existing.resolve() / target.relative_to(existing)
    if source == canonical or source in canonical.parents or canonical in source.parents:
        raise RuntimeError("目标目录不能通过替身回到原资料中。")
    return source, canonical


def unused(root, lock=None):
    # Machine-readable descriptors distinguish our held startup lock from every
    # other open file. Do not exempt the whole calling process (it may own a log
    # or a writable source file too). lsof can return 1 while reporting matches.
    check = subprocess.run(["/usr/sbin/lsof", "-Fpf", "+D", str(root)], capture_output=True, timeout=20)
    if check.returncode not in {0, 1} or check.stderr.strip():
        raise RuntimeError("无法核对引擎是否仍在使用，未执行备份或恢复。")
    allowed = (str(os.getpid()), str(lock.fileno())) if lock else None
    pid, holders = None, []
    for line in check.stdout.decode().splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("f"):
            holders.append((pid, line[1:]))
        else:
            raise RuntimeError("占用检查返回了无法识别的结果，未执行备份。")
    if any(holder != allowed for holder in holders) or (check.stdout.strip() and not holders):
        error = RuntimeError("独立引擎仍在使用，先正常关闭这份引擎；本工具不会停止其他进程。")
        error.holders = holders
        raise error


def settled(root, lock=None):
    # macOS FileProvider can briefly inspect a file just closed by PostgreSQL.
    # Retry only the observation, never a dump/restore or any original task.
    # Persistent or uninspectable holders still fail closed; no process is killed.
    deadline = time.monotonic() + 2
    while True:
        try:
            return unused(root, lock)
        except RuntimeError as error:
            if not getattr(error, "holders", None) or time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


def database_state(data):
    import psycopg
    from psycopg import sql
    with psycopg.connect(**database_connection(data, data["database"])) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        connection.execute("SET TIME ZONE 'UTC'")
        names = connection.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall()
        result = []
        for (name,) in names:
            value, count = hashlib.sha256(), 0
            with connection.cursor(name="snapshot_rows") as cursor:
                cursor.execute(sql.SQL("SELECT to_jsonb(t)::text FROM {} t ORDER BY to_jsonb(t)::text").format(sql.Identifier(name)))
                for (row,) in cursor:
                    raw = row.encode()
                    value.update(str(len(raw)).encode() + b":" + raw)
                    count += 1
            result.append({"table": name, "rows": count, "sha256": value.hexdigest()})
        return result


def database_command(config, data, args, log):
    env = {**safe_env(), "PGPASSWORD": config["password"]}
    with open(log, "ab") as output:
        os.chmod(log, 0o600)
        result = subprocess.run(args + ["--host=127.0.0.1", "--port=" + str(config["port"]),
                                       "--username=" + config["username"], "--dbname=" + data["database"]],
                                env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output, timeout=120)
    if result.returncode:
        raise RuntimeError("数据库备份或恢复未通过，请保留目标和私有日志，不重复执行原操作。")


def snapshot(source, target, *, lease=None):
    source, target = fresh(source, target)
    if lease and (lease.closed or Path(lease.name).resolve() != source / "startup.lock"):
        raise RuntimeError("备份锁不属于原引擎。")
    settled(source, lease)
    if any((source / name).exists() for name in ["engine-snapshot.json", "recovery-incomplete.json", "restore-incomplete.json"]):
        raise RuntimeError("来源不是已核对的引擎运行目录。")
    saved, infra, data = configuration(source)
    target.mkdir(parents=True, mode=0o700)
    write_private(target / "recovery-incomplete.json", {"source": str(source)})
    lock = lease if lease else open(source / "startup.lock", "a+")
    owned = OwnedInfrastructure(infra)
    try:
        if lease is None:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.chmod(lock.name, 0o600)
        settled(source, lock)
        before = files(source / "engine")
        try:
            owned.start_database()
            before_db = database_state(data)
            database_command(infra, data, [str(Path(infra["pg_bin"]) / "pg_dump"), "--format=custom",
                             "--no-owner", "--no-privileges", "--file=" + str(target / "engine.pgdump")], target / "snapshot.log")
            if before_db != database_state(data):
                raise RuntimeError("备份期间引擎数据库变化，目标保留为未完成候选。")
        finally:
            owned.close()
        settled(source, lock)
        shutil.copytree(source / "engine", target / "engine")
        for item in before:
            os.chmod(target / "engine" / item["path"], 0o600)
        if before != files(source / "engine") or before != files(target / "engine"):
            raise RuntimeError("备份期间原文件变化，未完成候选不可恢复。")
        os.chmod(target / "engine.pgdump", 0o600)
        write_private(target / "original-startup.json", saved)
        write_private(target / "original-infrastructure.json", infra)
        manifest = {"format": "synplex.engine-snapshot/1", "source": str(source), "database": before_db,
                    "files": [f for f in files(target) if f["path"] != "recovery-incomplete.json"],
                    "modelCalls": 0, "executorsEnabled": False}
        settled(source, lock)
        write_private(target / "engine-snapshot.json", manifest)
        (target / "recovery-incomplete.json").unlink()
    finally:
        if lease is None:
            lock.close()
    return {"snapshot": str(target), "tableCount": len(before_db), "modelCalls": 0}


def verify_snapshot(source):
    manifest = read_private(source / "engine-snapshot.json")
    if manifest.get("format") != "synplex.engine-snapshot/1" or (source / "recovery-incomplete.json").exists():
        raise RuntimeError("引擎快照未完成，不能恢复。")
    actual = [f for f in files(source) if f["path"] != "engine-snapshot.json"]
    if manifest["files"] != actual:
        raise RuntimeError("备份文件缺失或指纹变化，不能恢复。")
    return manifest


def compatible_restore_source(source, backend):
    saved = read_private(source / "original-startup.json")
    verify_source(backend, saved)
    verify_runtime(saved)
    if verify_environment(backend) != saved["lockSha256"]:
        raise RuntimeError("恢复环境的依赖锁与快照不同。")
    return saved


def restore(source, target, *, backend, pg_bin, valkey, api_port, redis_port, database_port):
    source, target = fresh(source, target)
    manifest = verify_snapshot(source)
    saved = compatible_restore_source(source, backend)
    if len({api_port, redis_port, database_port}) != 3:
        raise RuntimeError("三个服务需要不同地址。")
    for port in [api_port, redis_port, database_port]:
        available(port)
    target.mkdir(parents=True, mode=0o700)
    write_private(target / "restore-incomplete.json", {"snapshot": str(source), "executorsEnabled": False})
    infra = prepare(target / "infrastructure", pg_bin, port=database_port)
    shutil.copytree(source / "engine", target / "engine")
    if files(source / "engine") != files(target / "engine"):
        raise RuntimeError("恢复时原文件变化，执行器保持停用。")
    data = read_private(target / "engine/bootstrap.json")
    # Business/graph identities stay exact; only this verified private cluster's
    # connection and root paths change. Model configuration remains disabled.
    if data.get("runtime_format") != "synplex.engine-runtime/2" or data.get("model_mode") not in {"disabled", "configured"}:
        raise RuntimeError("本恢复工具仅接收已独立隔离的引擎快照。")
    from engine_provider import load_provider
    load_provider(target / "engine", data)
    data.update(backend=str(backend.resolve()), api_port=api_port, redis_port=redis_port,
                database_port=database_port, database_user=infra["username"], database_password=infra["password"],
                infrastructure_id=infra["id"], database_root=infra["pgdata"])
    private_json(target / "engine/bootstrap.json", data)
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        initialize(target / "engine", backend.resolve(), target / "infrastructure/infrastructure.json", api_port, redis_port)
        database_command(infra, data, [str(Path(pg_bin) / "pg_restore"), "--exit-on-error", "--no-owner", "--no-privileges",
                         str(source / "engine.pgdump")], target / "restore.log")
        if database_state(data) != manifest["database"]:
            raise RuntimeError("恢复后的完整数据指纹不一致，执行器保持停用。")
    finally:
        owned.close()
    saved.update(backend=str(backend.resolve()), valkey=str(valkey.resolve()), apiPort=api_port,
                 redisPort=redis_port, databasePort=database_port, infrastructureId=infra["id"])
    verify_snapshot(source)
    verify_source(backend, saved)
    write_private(target / "engine-startup.json", saved)
    write_private(target / "recovery.json", {"format": "synplex.engine-restoration/1", "snapshot": str(source),
                  "executorsEnabled": False, "modelCalls": 0,
                  "notice": "数据库、文件与队列原样保全。先核对未完成任务与原执行身份，不自动重发或启动工作进程。"})
    (target / "restore-incomplete.json").unlink()
    return {"restored": str(target), "tableCount": len(manifest["database"]), "executorsEnabled": False, "modelCalls": 0}


def workspace_command(node, *args):
    tool = Path(__file__).resolve().parents[2] / "scripts/runtime/recovery.mjs"
    result = subprocess.run([str(node.resolve()), str(tool), *map(str, args)], env=safe_env(),
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    if result.returncode:
        # Never relay credential-bearing third-party exception text.
        raise RuntimeError("工作台资料核对未通过，联合操作未完成；请保留原目录及未完成候选。")


def product_snapshot(workspace, engine, target, *, node):
    workspace = workspace.resolve()
    engine, target = fresh(engine, target)
    fresh(workspace, target)
    if workspace == engine or workspace in engine.parents or engine in workspace.parents:
        raise RuntimeError("工作台和引擎资料必须分别保存，不能互相嵌套。")
    settled(engine)
    saved, infra, data = configuration(engine)
    if data.get("runtime_format") != "synplex.engine-runtime/2" or data.get("model_mode") not in {"disabled", "configured"}:
        raise RuntimeError("联合备份目前只接收本产品已隔离的引擎。")
    target.mkdir(parents=True, mode=0o700)
    write_private(target / "product-incomplete.json", {"workspace": str(workspace), "engine": str(engine)})
    with open(engine / "startup.lock", "a+") as lock, workspace_maintenance(node, workspace) as workspace_guard:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.chmod(lock.name, 0o600)
        settled(engine, lock)
        # The engine stays stopped/locked across the workspace's SQLite snapshot.
        # Native PG startup below changes no business rows; every table is checked.
        workspace_guard.request("backup", target / "workspace")
        snapshot(engine, target / "engine", lease=lock)
        workspace_guard.request("verify-source", target / "workspace")
        if configuration(engine) != (saved, infra, data):
            raise RuntimeError("联合备份期间引擎设置变化，候选不可恢复。")
        settled(engine, lock)
        workspace_guard.request("check-unused")
        manifest = {"format": "synplex.product-snapshot/1", "workspace": str(workspace), "engine": str(engine),
                    "files": [f for f in files(target) if f["path"] != "product-incomplete.json"],
                    "modelCalls": 0, "executorsEnabledAfterRestore": False,
                    "limitation": "包含私人连接资料。保全原远端身份，不自动映射或重发未知任务；恢复执行器停用。"}
        write_private(target / "product-snapshot.json", manifest)
        (target / "product-incomplete.json").unlink()
    return {"snapshot": str(target), "workspaceAndEngineIncluded": True, "modelCalls": 0}


def verify_product(source, *, node):
    manifest = read_private(source / "product-snapshot.json")
    if manifest.get("format") != "synplex.product-snapshot/1" or (source / "product-incomplete.json").exists():
        raise RuntimeError("联合快照未完成，不能恢复。")
    actual = [f for f in files(source) if f["path"] != "product-snapshot.json"]
    if manifest["files"] != actual:
        raise RuntimeError("联合快照有文件缺失或变化，不能恢复。")
    verify_snapshot(source / "engine")
    workspace_command(node, "verify", source / "workspace")
    return manifest


def product_restore(source, target, *, node, workspace_port, **engine_options):
    source, target = fresh(source, target)
    verify_product(source, node=node)
    compatible_restore_source(source / "engine", engine_options["backend"])
    ports = [workspace_port, *[engine_options[name] for name in ["api_port", "redis_port", "database_port"]]]
    if len(set(ports)) != 4:
        raise RuntimeError("恢复需要四个不同的空闲地址。")
    for port in ports:
        available(port)
    target.mkdir(parents=True, mode=0o700)
    write_private(target / "restore-incomplete.json", {"snapshot": str(source), "executorsEnabled": False})
    workspace_command(node, "restore", source / "workspace", target / "workspace", workspace_port)
    restore(source / "engine", target / "engine", **engine_options)
    verify_product(source, node=node)
    from handoff_state import PROTOCOL
    from recovery_entry import write_recovery_entry
    supports_handoff = read_private(target / "engine/engine-startup.json").get("handoffProtocol") == PROTOCOL
    if supports_handoff:
        write_recovery_entry(source, target, node=node)
    write_private(target / "product-recovery.json", {"format": "synplex.product-restoration/1", "snapshot": str(source),
                  "executorsEnabled": False, "modelCalls": 0, "remoteIdentitiesRemapped": False,
                  "nextAction": ("执行器仍停用。正常关闭原实例和副本后，可打开本恢复目录的“核对并启用副本”入口；只处理首次闲置恢复，不重发任务。" if supports_handoff else
                                 "可先打开恢复工作台查看资料。执行器保持停用；原远端任务须按原身份核对，不能直接重新执行。")})
    (target / "restore-incomplete.json").unlink()
    return {"restored": str(target), "workspace": str(target / "workspace"), "engine": str(target / "engine"),
            "executorsEnabled": False, "remoteIdentitiesRemapped": False, "modelCalls": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "restore", "backup-product", "restore-product", "inspect-product"])
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--backend", type=Path)
    parser.add_argument("--postgres-bin", type=Path)
    parser.add_argument("--valkey", type=Path)
    parser.add_argument("--api-port", type=int)
    parser.add_argument("--redis-port", type=int)
    parser.add_argument("--database-port", type=int)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--workspace-port", type=int)
    parser.add_argument("--node", type=Path)
    args = parser.parse_args()
    if args.action == "inspect-product":
        if not args.node:
            raise RuntimeError("原任务核对需要明确的Node运行环境。")
        from engine_reconcile import inspect_product
        result = inspect_product(args.source, args.target, node=args.node)
    elif args.action == "backup-product":
        if not args.workspace or not args.node:
            raise RuntimeError("联合备份需要明确工作台资料目录和Node运行环境。")
        result = product_snapshot(args.workspace, args.source, args.target, node=args.node)
    elif args.action == "backup":
        result = snapshot(args.source, args.target)
    else:
        if not all([args.backend, args.postgres_bin, args.valkey, args.api_port, args.redis_port, args.database_port]):
            raise RuntimeError("恢复需要明确环境与三个空闲地址。")
        options = dict(backend=args.backend, pg_bin=args.postgres_bin, valkey=args.valkey,
                       api_port=args.api_port, redis_port=args.redis_port, database_port=args.database_port)
        if args.action == "restore-product":
            if not args.node or not args.workspace_port:
                raise RuntimeError("联合恢复需要明确工作台地址和Node运行环境。")
            result = product_restore(args.source, args.target, node=args.node, workspace_port=args.workspace_port, **options)
        else:
            result = restore(args.source, args.target, **options)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except SourceCompatibilityError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        if sys.argv[1:2] != ["inspect-product"]:
            raise
        print("原任务核对未完成；请保留备份和恢复目录，执行工具仍停用，没有重新发送任务。", file=sys.stderr)
        sys.exit(1)
