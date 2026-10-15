"""Inspect persisted broker work on a private COPY, never the original broker.

Starting Valkey can rewrite its files even without messages. Loading a bounded
copy avoids altering the snapshot being compared. No consumer or worker starts.
"""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time

from engine_runtime import ensure_queue_idle
from private_infrastructure import safe_env, read_private


def inspect_queue_copy(snapshot_engine, saved, data):
    from redis import Redis
    from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
    source = snapshot_engine / "engine/valkey"
    size = sum(path.stat().st_size for path in source.rglob("*") if path.is_file())
    if size > 64 * 1024 * 1024:
        raise RuntimeError("原队列超过本次安全核对容量，保留原队列，不能自动接管。")
    text = (snapshot_engine / "engine/valkey.conf").read_text()
    origin = Path(read_private(snapshot_engine / "engine-snapshot.json")["source"]) / "engine/valkey"
    original = (f'bind 127.0.0.1\nport {data["redis_port"]}\nprotected-mode yes\n'
                f'requirepass {data["redis_password"]}\ndir "{origin}"\n'
                'appendonly yes\nsave 60 1\ndaemonize no\n')
    # The archived configuration names its ORIGINAL state directory.
    if text != original:
        raise RuntimeError("原队列配置不是已核对的隔离格式，不能借默认设置接管。")
    with tempfile.TemporaryDirectory(prefix="synplex-handoff-queue-") as folder:
        root = Path(folder)
        shutil.copytree(source, root / "queue")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        password = secrets.token_hex(32)
        with open(root / "queue.log", "xb") as log:
            os.chmod(log.name, 0o600)
            child = subprocess.Popen([saved["valkey"], "--bind", "127.0.0.1", "--port", str(port),
                "--protected-mode", "yes", "--requirepass", password, "--dir", str(root / "queue"),
                "--appendonly", "yes", "--save", "", "--daemonize", "no"],
                env=safe_env(), stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            client = Redis(host="127.0.0.1", port=port, password=password, socket_connect_timeout=1, socket_timeout=1)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if child.poll() is not None:
                        raise RuntimeError("队列副本核对未启动，原队列仍保留。")
                    try:
                        if client.ping():
                            break
                    except (RedisConnectionError, RedisTimeoutError):
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError("队列副本核对超时，未重新派发任何消息。")
                    time.sleep(0.05)
                ensure_queue_idle({"redis_port": port, "redis_password": password})
            finally:
                client.close()
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=15)
    return {"persistedQueueChecked": True, "originalQueueStarted": False, "messagesReplayed": False}
