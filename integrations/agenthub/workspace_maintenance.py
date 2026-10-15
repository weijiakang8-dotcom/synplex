"""Retain the workspace's native lock throughout joint offline maintenance.

One owned Node process holds a SQLite write transaction, not a reusable flag or
PID identity. No model, broker, API, worker or executor is loaded by the guard.
Closing this pipe or losing the Python owner ends the guard and releases the
kernel-managed lock. A failed phase is never automatically retried.
"""
from contextlib import contextmanager
import json
from pathlib import Path
import selectors
import subprocess

from private_infrastructure import safe_env


class WorkspaceMaintenance:
    def __init__(self, child):
        self.child = child

    def receive(self):
        with selectors.DefaultSelector() as selector:
            selector.register(self.child.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=130):
                raise RuntimeError("工作台维护等待超时，保留原资料，未重新执行任务。")
        line = self.child.stdout.readline(4 * 1024 * 1024 + 1)
        if not line.endswith(b'\n') or len(line) > 4 * 1024 * 1024:
            raise RuntimeError("工作台维护进程已退出或回执不完整，不能继续联合操作。")
        return json.loads(line)

    def request(self, action, target=None):
        if self.child.poll() is not None:
            raise RuntimeError("资料维护保护已经结束，未继续联合操作。")
        command = {"action": action}
        if target is not None:
            command['target'] = str(target)
        self.child.stdin.write(json.dumps(command).encode() + b'\n')
        self.child.stdin.flush()
        result = self.receive()
        if result.get('ok') is not True or set(result) != {'ok', 'result'}:
            raise RuntimeError("资料维护核对未完成，请保留原资料及未完成候选。")
        return result['result']


@contextmanager
def workspace_maintenance(node, workspace):
    tool = Path(__file__).resolve().parents[2] / 'scripts/runtime/recovery.mjs'
    child = subprocess.Popen([str(node.resolve()), str(tool), 'guard', str(workspace)],
                             env=safe_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, bufsize=0)
    guard = WorkspaceMaintenance(child)
    try:
        ready = guard.receive()
        if ready != {'format': 'synplex.workspace-maintenance/1', 'ready': True}:
            raise RuntimeError("原工作台尚未关闭或无法取得维护保护，未继续联合操作。")
        yield guard
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()  # Only this Popen child, never an observed PID.
            child.wait(timeout=5)
        finally:
            child.stdout.close()
