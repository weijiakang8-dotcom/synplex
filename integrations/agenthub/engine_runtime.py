"""Explicit, isolated engine setup and supervised local startup (no model calls)."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import urllib.request

from local_runner import initialize, private_read
from private_infrastructure import prepare, OwnedInfrastructure, safe_env, write_private, available
from source_identity import source_identity, verify_source, runtime_identity, verify_runtime, SourceCompatibilityError


def verify_environment(backend):
    prefix = Path(sys.prefix).resolve()
    record = private_read(prefix / "synplex-environment.json")
    lock = (backend / "requirements.lock").read_bytes()
    if record.get("status") != "complete" or record.get("lockSha256") != hashlib.sha256(lock).hexdigest():
        raise RuntimeError("Use this product's verified, independently installed Python environment")
    for line in lock.decode().splitlines():
        if line and not line.startswith(("#", " ")):
            name, version = line.strip().split("==")
            if importlib.metadata.version(name) != version:
                raise RuntimeError("Installed dependency differs from the evaluated lock")
    return record["lockSha256"]


def setup(root, backend, pg_bin, valkey, *, api_port, redis_port, database_port):
    root, backend = root.absolute(), backend.resolve()
    if root.exists():
        raise RuntimeError("Setup needs a new private directory; preserve existing data and inspect its original setup")
    lock_hash = verify_environment(backend)
    source = source_identity(backend)
    runtime_source = runtime_identity()
    for port in [api_port, redis_port, database_port]:available(port)
    if len({api_port,redis_port,database_port}) != 3:
        raise RuntimeError("Each engine service needs its own port")
    root.mkdir(parents=True, mode=0o700)
    write_private(root / "setup-incomplete.json", {"format":"synplex.engine-startup/1","status":"preparing"})
    infrastructure = prepare(root / "infrastructure", pg_bin, port=database_port)
    owned = OwnedInfrastructure(infrastructure)
    try:
        owned.start_database()
        initialize(root / "engine", backend, root / "infrastructure/infrastructure.json", api_port, redis_port)
    finally:
        owned.close()
    from handoff_state import PROTOCOL
    config={"format":"synplex.engine-startup/1","handoffProtocol":PROTOCOL,"backend":str(backend),"lockSha256":lock_hash,"sourceIdentity":source,"runtimeIdentity":runtime_source,
            "valkey":str(valkey.absolute()),"apiPort":api_port,"redisPort":redis_port,"databasePort":database_port,
            "infrastructureId":infrastructure["id"],"modelCalls":0,"providerConfigured":False}
    verify_source(backend, config)
    verify_runtime(config)
    write_private(root / "engine-startup.json",config)
    os.replace(root / "setup-incomplete.json",root / "setup-intent.json")
    return config


def configuration(root):
    if root.is_symlink() or any((root / marker).exists() for marker in ["setup-incomplete.json", "restore-incomplete.json", "recovery-incomplete.json", "engine-snapshot.json", "provider-update-incomplete.json"]):
        raise RuntimeError("Engine setup is incomplete or the directory is not private")
    saved=private_read(root / "engine-startup.json")
    if saved.get("format")!="synplex.engine-startup/1":raise RuntimeError("Unknown engine startup format")
    backend=Path(saved["backend"]).resolve()
    verify_source(backend, saved)
    verify_runtime(saved)
    if verify_environment(backend)!=saved["lockSha256"]:raise RuntimeError("Engine source dependency version changed")
    infrastructure=private_read(root / "infrastructure/infrastructure.json")
    state=private_read(root / "engine/bootstrap.json")
    if (saved["apiPort"]!=state["api_port"] or saved["redisPort"]!=state["redis_port"]
            or saved["databasePort"]!=infrastructure["port"] or infrastructure["id"]!=saved["infrastructureId"] or state.get("infrastructure_id")!=infrastructure["id"]
            or Path(state["backend"]).resolve()!=backend or Path(infrastructure["pgdata"]).resolve()!=(root / "infrastructure/postgres").resolve()):
        raise RuntimeError("Engine, source and database identities differ")
    from engine_provider import load_provider
    from model_relay import enabled as relay_enabled
    configured = load_provider(root / "engine", state) is not None or relay_enabled(state)
    if saved.get("providerConfigured") is not configured:
        raise RuntimeError("模型配置状态不一致，不能自动启用。")
    return saved,infrastructure,state


def ensure_execution_allowed(root):
    from handoff_state import ensure_admission
    ensure_admission(root)


@contextmanager
def startup_lease(root, *, inherited_fd=None, shared=False):
    """Hold the same kernel lease for the whole service/maintenance lifetime.

    A supervised child inherits the parent's exclusive open-file description;
    claiming EX again verifies ownership without downgrading the parent's lock.
    Executable entries hold an exclusive lease. The shared option is for
    read-only inspection/probes, never for independently started services.
    A parent crash cannot release a live child's lease.
    This is local lifecycle coordination, not protection against a hostile OS
    account which can edit this product's files or start unrelated programs.
    """
    path = root / "startup.lock"
    fd = None
    try:
        if inherited_fd is None:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        else:
            if type(inherited_fd) is not int or inherited_fd < 3:
                raise RuntimeError("引擎启动凭据无效，没有启动服务。")
            fd = os.dup(inherited_fd)
            os.close(inherited_fd)
        actual, named = os.fstat(fd), path.lstat()
        if (not stat.S_ISREG(actual.st_mode) or stat.S_ISLNK(named.st_mode)
                or actual.st_uid != os.getuid() or actual.st_mode & 0o077
                or (actual.st_dev, actual.st_ino) != (named.st_dev, named.st_ino)):
            raise RuntimeError("引擎运行锁身份不一致，没有启动服务。")
        mode = fcntl.LOCK_SH if shared and inherited_fd is None else fcntl.LOCK_EX
        try:
            fcntl.flock(fd, mode | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("引擎正在运行或维护；本次没有重复启动，也没有修改原任务。") from error
        # Path replacement must not turn the held descriptor into another lock.
        named = path.lstat()
        if (actual.st_dev, actual.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("引擎运行锁发生变化，没有启动服务。")
        with os.fdopen(fd, "r+") as lease:
            fd = None
            yield lease
    finally:
        if fd is not None:
            os.close(fd)


def supervise(root):
    root=root.resolve()
    with startup_lease(root) as lease:
        return _supervise_locked(root, lease)


def ensure_database_idle(data):
    """Read-only admission check, before a dispatcher or worker can start."""
    import psycopg
    from local_runner import database_connection
    with psycopg.connect(**database_connection(data, data["database"])) as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        tables = db.execute("SELECT to_regclass('public.executions'),to_regclass('public.outbox_events'),to_regclass('public.tool_calls')").fetchone()
        if not any(tables):
            return  # Clean setup, before the first API initializes its tables.
        if not all(tables):
            raise RuntimeError("原任务的数据表尚未完整核对，不能自动补表后继续执行。")
        active = db.execute("SELECT count(*) FROM executions WHERE status NOT IN ('completed','failed','rolled_back') OR status IS NULL OR lease_owner IS NOT NULL").fetchone()[0]
        unpublished = db.execute("SELECT count(*) FROM outbox_events WHERE published_at IS NULL").fetchone()[0]
        tools = db.execute("SELECT count(*) FROM tool_calls WHERE status NOT IN ('success','failed','rejected') OR status IS NULL").fetchone()[0]
        if active or unpublished or tools:
            raise RuntimeError("原任务、待发送操作或工具结果尚未核对，不能自动重启执行。")


def disabled_evaluation_id(raw):
    """Recognize only inert post-run evaluation messages; never execute them."""
    import base64
    import uuid
    if len(raw) > 65536:
        raise RuntimeError("停用的评估记录过大，需先核对。")
    try:
        message = json.loads(raw)
        properties = message['properties']
        if (message.get('content-type') != 'application/json' or properties.get('body_encoding') != 'base64'
                or message.get('headers', {}).get('task') != 'agenthub.evaluate_execution'
                or properties.get('delivery_info') != {'exchange': '', 'routing_key': 'synplex-evaluation-disabled'}):
            raise ValueError('unexpected disabled message')
        args, kwargs, options = json.loads(base64.b64decode(message['body'], validate=True))
        if (not isinstance(args, list) or len(args) != 1 or kwargs != {} or not isinstance(options, dict)
                or set(options) - {'callbacks', 'errbacks', 'chain', 'chord'} or any(options.values())):
            raise ValueError('unexpected evaluation arguments')
        return str(uuid.UUID(args[0]))
    except (ValueError, TypeError, KeyError, AttributeError):
        raise RuntimeError("停用队列中有无法确认的操作，未删除或重新派发。") from None


def verify_disabled_evaluations(client, key, data):
    """Keep bytes in the disabled queue, but distinguish them from active work."""
    import psycopg
    from local_runner import database_connection
    size = client.llen(key)
    if size > 10000:
        raise RuntimeError("停用的评估记录需要整理核对，本次未自动清理。")
    with psycopg.connect(**database_connection(data, data['database'])) as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        for offset in range(0, size, 128):
            messages = client.lrange(key, offset, min(size - 1, offset + 127))
            if len(messages) != min(128, size - offset):
                raise RuntimeError("队列记录发生变化，未继续。")
            for raw in messages:
                execution_id = disabled_evaluation_id(raw)
                row = db.execute("SELECT status,lease_owner,organization_id FROM executions WHERE id=%s", (execution_id,)).fetchone()
                if (not row or row[0] not in {'completed', 'failed', 'rolled_back'} or row[1] is not None
                        or str(row[2]) != data['organization_id']):
                    raise RuntimeError("停用的评估记录对应任务尚未结束或归属不符，需先核对。")
    if client.llen(key) != size:
        raise RuntimeError("队列记录发生变化，未继续。")


def ensure_queue_idle(data):
    """The private broker's ready AND unacknowledged work must be preserved."""
    from redis import Redis
    client = Redis(host="127.0.0.1", port=data["redis_port"], password=data["redis_password"],
                   socket_connect_timeout=5, socket_timeout=5)
    try:
        for key in client.scan_iter():
            kind = client.type(key)
            # Kombu's bindings are sets, not executable messages. Include all
            # priority queue lists and unacked hash/index, without deleting any.
            pending = ((kind == b'list' and client.llen(key))
                       or (key == b'unacked' and client.hlen(key))
                       or (key == b'unacked_index' and client.zcard(key)))
            # The isolated worker consumes ONLY synplex-isolated. Old code
            # deliberately routes paid post-run evaluation elsewhere. Preserve
            # those messages, validate their terminal task, never consume them.
            if pending and kind == b'list' and key == b'synplex-evaluation-disabled':
                verify_disabled_evaluations(client, key, data)
                continue
            if pending:
                raise RuntimeError("原队列仍有待核对的工作，未移除或重新派发任何消息。")
    finally:
        client.close()


def _supervise_locked(root, lock_file):
    # Configuration and recovery checks belong INSIDE the same lifetime lease.
    # A check made before locking can be stale by the time services start.
    saved,infra,data=configuration(root)
    ensure_execution_allowed(root)
    runner=Path(__file__).with_name("local_runner.py")
    owned=OwnedInfrastructure(infra);children=[];logs=[];stopping=False
    previous={}
    def request_stop(*args):
        nonlocal stopping
        stopping=True
    # Install handlers before starting any owned infrastructure. A close during
    # database startup must enter finally rather than orphaning owned children.
    for signum in [signal.SIGINT,signal.SIGTERM]:
        previous[signum]=signal.signal(signum,request_stop)
    try:
        available(data["api_port"]);available(data["redis_port"])
        owned.start_database()
        if stopping:return
        # A service start is not authorization to redeliver old work. Until
        # explicit engine-level recovery is available, refuse an ambiguous queue.
        ensure_database_idle(data)
        owned.start_queue(saved["valkey"],root / "engine")
        if stopping:return
        ensure_queue_idle(data)
        for command in ["api","worker"]:
            log=open(root / (command+".log"),"ab");os.chmod(log.name,0o600);logs.append(log)
            children.append(subprocess.Popen([sys.executable,"-B",str(runner),"--state",str(root / "engine"),"--backend",saved["backend"],
                                  "--supervisor-lease-fd",str(lock_file.fileno()),command],
                                 stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=safe_env(),pass_fds=(lock_file.fileno(),)))
        deadline=time.monotonic()+25
        while not stopping:
            if any(child.poll() is not None for child in children):raise RuntimeError("Owned engine process exited; data preserved, no task replay")
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{data["api_port"]}/health/live',timeout=1) as response:
                    if response.status==200:break
            except OSError:pass
            if time.monotonic()>deadline:raise RuntimeError("Engine API startup did not complete")
            time.sleep(0.1)
        if stopping:return
        print(json.dumps({"format":"synplex.engine-ready/1","endpoint":f'http://127.0.0.1:{data["api_port"]}',
                          "providerConfigured":saved["providerConfigured"],"modelCalls":0}),flush=True)
        # Never resubmit queued/unknown work after a worker fault. Stop the owned
        # group and leave original outbox/checkpoints for explicit reconciliation.
        while not stopping:
            if any(child.poll() is not None for child in children+owned.children):
                raise RuntimeError("Owned engine process exited; inspect original work before restarting")
            time.sleep(0.2)
    finally:
        errors=[]
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=15)
                except subprocess.TimeoutExpired:errors.append("Engine process is still stopping; preserve data")
        for log in logs:log.close()
        try:owned.close()
        finally:
            for signum,handler in previous.items():signal.signal(signum,handler)
        if errors:raise RuntimeError("; ".join(errors))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=["setup","run","check","configure-provider","configure-relay"])
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--backend",type=Path)
    parser.add_argument("--postgres-bin",type=Path)
    parser.add_argument("--valkey",type=Path)
    parser.add_argument("--api-port",type=int,default=5214)
    parser.add_argument("--redis-port",type=int,default=5216)
    parser.add_argument("--database-port",type=int,default=5218)
    parser.add_argument("--profile",type=Path)
    parser.add_argument("--relay-endpoint")
    args=parser.parse_args()
    if args.command=="setup":
        if not all([args.backend,args.postgres_bin,args.valkey]):raise RuntimeError("Explicit engine source and database/queue tools required")
        setup(args.root,args.backend,args.postgres_bin,args.valkey,api_port=args.api_port,redis_port=args.redis_port,database_port=args.database_port)
        print("独立引擎准备完成；尚未配置模型，不会产生模型费用。")
    elif args.command=="configure-provider":
        if not args.profile:raise RuntimeError("需要明确的私有模型连接配置文件")
        from engine_provider import configure
        print(json.dumps(configure(args.root,args.profile),ensure_ascii=False))
    elif args.command=="configure-relay":
        from model_relay import configure
        print(json.dumps(configure(args.root,args.relay_endpoint),ensure_ascii=False))
    elif args.command=="check":
        configuration(args.root.resolve())
        ensure_execution_allowed(args.root.resolve())
        print("引擎环境与数据身份核对通过；真实模型执行尚未验收。")
    else:supervise(args.root)


if __name__=="__main__":
    try:main()
    except SourceCompatibilityError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Subprocess logs stay private; never relay arbitrary SQL or credentials.
        print("独立引擎未能完成当前操作，请保留数据并核对私有运行记录。",file=sys.stderr)
        sys.exit(1)
