"""Own a new PostgreSQL cluster and private queue; never control saved PIDs.

Existing shared databases, profiles, daemons and install locations are read-only.
Only subprocess handles created by this instance can be stopped.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import uuid


def read_private(path):
    path = Path(path)
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise RuntimeError("Infrastructure state must be an owner-only file")
    return json.loads(path.read_text())


def write_private(path, value):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(value, file)
    os.replace(temporary, path)


def available(port):
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise RuntimeError("Invalid local infrastructure port")
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))


def prepare(root, pg_bin, *, port):
    root, pg_bin = Path(root).absolute(), Path(pg_bin).resolve()
    if root.is_symlink():
        raise RuntimeError("Infrastructure cannot be a symlink")
    if root.exists():
        file = root / "infrastructure.json"
        if not file.exists():
            raise RuntimeError("Existing directory is not this engine's infrastructure; preserve it")
        saved = read_private(file)
        if (saved.get("format") != "synplex.engine-infrastructure/1" or saved["port"] != port
                or Path(saved["pgdata"]).resolve() != (root / "postgres").resolve()
                or Path(saved["pg_bin"]).resolve() != pg_bin or (root / "prepare-incomplete.json").exists()):
            raise RuntimeError("Infrastructure identity changed or initialization is incomplete")
        return saved
    available(port)
    root.mkdir(parents=True, mode=0o700)
    saved = {"format": "synplex.engine-infrastructure/1", "id": uuid.uuid4().hex,
             "host": "127.0.0.1", "port": port, "username": "synplex",
             "password": secrets.token_hex(32), "pgdata": str(root / "postgres"),
             "pg_bin": str(pg_bin), "socket_dir": str(root / "socket")}
    write_private(root / "prepare-incomplete.json", saved)
    pwfile = root / "password"
    with os.fdopen(os.open(pwfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(saved["password"])
    (root / "socket").mkdir(mode=0o700)
    with open(root / "initialization.log", "xb") as log:
        os.chmod(log.name, 0o600)
        result = subprocess.run([str(pg_bin / "initdb"), "-D", saved["pgdata"], "--username=synplex",
                                 "--auth-local=trust", "--auth-host=scram-sha-256", "--encoding=UTF8",
                                 "--no-locale", "--pwfile=" + str(pwfile)], env=safe_env(), stdout=log, stderr=log)
    if result.returncode:
        raise RuntimeError("Private cluster initialization failed; preserve its log and intent")
    write_private(root / "infrastructure.json", saved)
    os.replace(root / "prepare-incomplete.json", root / "prepare-intent.json")
    return saved


def safe_env():
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ["HOME"],
            "TMPDIR": os.environ.get("TMPDIR", "/tmp"), "PYTHONDONTWRITEBYTECODE": "1",
            "OTEL_SDK_DISABLED": "true", "LC_ALL": "C", "LANG": "C"}


class OwnedInfrastructure:
    def __init__(self, config):
        self.config, self.children, self.logs = config, [], []

    def _start(self, command, log):
        output = open(log, "ab")
        os.chmod(log, 0o600)
        self.logs.append(output)
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=output, env=safe_env())
        self.children.append(child)
        return child

    def start_database(self):
        import psycopg
        c = self.config
        available(c["port"])
        if (Path(c["pgdata"]) / "postmaster.pid").exists():
            raise RuntimeError("Private database has a saved PID; inspect the original instance, never kill it")
        child = self._start([str(Path(c["pg_bin"]) / "postgres"), "-D", c["pgdata"], "-h", c["host"],
                             "-p", str(c["port"]), "-k", "", "-c", "shared_buffers=32MB",
                             "-c", "max_connections=30"], Path(c["pgdata"]).parent / "postgres.log")
        for _ in range(150):
            if child.poll() is not None:
                raise RuntimeError("Private database exited; inspect its log")
            try:
                with psycopg.connect(host=c["host"], port=c["port"], user=c["username"], password=c["password"],
                                     dbname="postgres", connect_timeout=1) as connection:
                    if Path(connection.execute("SHOW data_directory").fetchone()[0]).resolve() != Path(c["pgdata"]).resolve():
                        raise RuntimeError("Database ownership mismatch")
                    return
            except psycopg.OperationalError:
                time.sleep(0.1)
        raise RuntimeError("Private database did not become ready")

    def start_queue(self, binary, state):
        from redis import Redis
        state = Path(state)
        data = read_private(state / "bootstrap.json")
        available(data["redis_port"])
        if data.get("infrastructure_id") != self.config["id"]:
            raise RuntimeError("Queue belongs to another infrastructure")
        child = self._start([str(Path(binary).resolve()), str(state / "valkey.conf")], state / "queue.log")
        client = Redis(host="127.0.0.1", port=data["redis_port"], password=data["redis_password"],
                       socket_connect_timeout=1, socket_timeout=1)
        try:
            for _ in range(100):
                if child.poll() is not None:
                    raise RuntimeError("Private queue exited; inspect its log")
                try:
                    if client.ping():
                        return
                except Exception:
                    time.sleep(0.1)
        finally:
            client.close()
        raise RuntimeError("Private queue did not become ready")

    def close(self):
        errors = []
        for child in reversed(self.children):
            if child.poll() is None:
                child.terminate()  # Only the handle spawned here; no PID-file authorization.
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    errors.append("Owned process is still stopping; preserve its files")
        for output in self.logs:
            output.close()
        if errors:
            raise RuntimeError("; ".join(errors))
