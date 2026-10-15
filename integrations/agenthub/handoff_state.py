"""Durable, fail-closed admission for an explicitly transferred local product.

The stopped original is retained as the authority witness. This is not a
distributed consensus protocol or protection against its OS owner editing data.
No execution is permitted by a copied flag alone, and no stale marker is deleted.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import stat
import uuid
import re

from local_runner import private_read

PROTOCOL = "synplex.idle-product-handoff/1"
RETIRED = "handoff-retired.json"
PENDING = "handoff-pending.json"
COMPLETE = "handoff-complete.json"


def private_directory(path):
    path = Path(path)
    info = path.lstat()
    if (not path.is_absolute() or not stat.S_ISDIR(info.st_mode)
            or path.is_symlink() or path.resolve() != path
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError("接续资料的位置不完整或不安全，请保留原目录。")
    return path


def validate_proof(proof):
    if (not isinstance(proof, dict) or set(proof) != {"format", "id", "snapshot", "snapshotSha256", "source", "target"}
            or proof.get("format") != PROTOCOL or str(uuid.UUID(proof["id"])) != proof["id"]
            or not re.fullmatch(r"[a-f0-9]{64}", proof.get("snapshotSha256", ""))):
        raise RuntimeError("接续记录不完整，不能启用恢复副本。")
    roots = []
    for name in ["source", "target"]:
        part = proof[name]
        if not isinstance(part, dict) or set(part) != {"workspace", "engine", "engineId", "infrastructureId"}:
            raise RuntimeError("接续记录缺少原实例或恢复副本的身份。")
        for key in ["workspace", "engine"]:
            roots.append(private_directory(part[key]))
        if not all(isinstance(part[key], str) and part[key] for key in ["engineId", "infrastructureId"]):
            raise RuntimeError("接续记录缺少执行身份。")
    for index, path in enumerate(roots):
        if any(path == other or path in other.parents or other in path.parents for other in roots[index + 1:]):
            raise RuntimeError("原实例和恢复副本的位置必须分开。")
    target = proof["target"]
    if (Path(target["workspace"]).parent != Path(target["engine"]).parent
            or target["engineId"] != proof["source"]["engineId"]):
        raise RuntimeError("恢复副本不属于同一份联合恢复目录。")
    return proof


def durable_json(path, value, *, once=False):
    """Publish a complete private record; fsync before and after publication.

    once=True uses a link instead of an overwriting rename: an earlier transfer
    cannot be replaced, even after its caller lost the acknowledgement.
    """
    path = Path(path)
    temp = path.parent / (".handoff-" + secrets.token_hex(12))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, sort_keys=True)
            file.flush()
            os.fsync(file.fileno())
        if once:
            try:
                os.link(temp, path)
            except FileExistsError:
                if private_read(path) != value:
                    raise RuntimeError("已有另一份接续记录，未覆盖或启用任何实例。")
        else:
            os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temp.exists():
            temp.unlink()


def proof_for_target(root, proof, kind, *, complete=True):
    validate_proof(proof)
    root = private_directory(root)
    if root != Path(proof["target"][kind]):
        raise RuntimeError("接续记录不属于这份恢复副本，没有启动执行。")
    for key in ["engine", "workspace"]:
        if private_read(Path(proof["source"][key]) / RETIRED) != proof:
            raise RuntimeError("原实例尚未完整停用，恢复副本保持停用。")
    if complete and private_read(root.parent / COMPLETE) != proof:
        raise RuntimeError("接续尚未完成，请按原记录继续核对，不要重复执行任务。")
    saved = private_read(Path(proof["target"]["engine"]) / "engine-startup.json")
    bootstrap = private_read(Path(proof["target"]["engine"]) / "engine/bootstrap.json")
    if (saved["infrastructureId"] != proof["target"]["infrastructureId"]
            or bootstrap["id"] != proof["target"]["engineId"]):
        raise RuntimeError("恢复副本的执行身份已经变化，没有启动执行。")
    return proof


def ensure_admission(root):
    root = Path(root).resolve()
    if (root / RETIRED).exists() or (root / RETIRED).is_symlink():
        raise RuntimeError("这份原实例已停止使用，请打开核对后的恢复副本；原资料仍保留。")
    recovery = root / "recovery.json"
    if not recovery.exists() and not recovery.is_symlink():
        return
    record = private_read(recovery)
    if record.get("executorsEnabled") is not True:
        raise RuntimeError("恢复后的执行器保持停用；先核对原任务、队列及连接身份，不自动重发。")
    proof = proof_for_target(root, record.get("handoff"), "engine")
    workspace = private_read(Path(proof["target"]["workspace"]) / "recovery.json")
    if workspace.get("executorsEnabled") is not True or workspace.get("handoff") != proof:
        raise RuntimeError("工作台与执行器的接续状态不同，没有启动执行。")
