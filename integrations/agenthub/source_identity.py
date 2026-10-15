"""Content identity for the executable backend shipped in a local release.

This is a compatibility guard, not a signature, security review or migration.
Wrapper code has its own exact identity and release inventory; mutable data
and bytecode are excluded. Paths are relative so an exact copy can restore.
"""
from __future__ import annotations

import hashlib
from pathlib import Path


class SourceCompatibilityError(RuntimeError):
    """Safe actionable text; never includes source paths or connection data."""


def source_identity(backend: Path):
    backend = backend.resolve()
    paths = []
    for name in ["app", "alembic"]:
        directory = backend / name
        if directory.is_symlink() or not directory.is_dir():
            raise SourceCompatibilityError("执行源码不完整，请保留原环境并核对安装包。")
        pending = [directory]
        while pending:
            for file in sorted(pending.pop().iterdir()):
                if file.is_symlink():
                    raise SourceCompatibilityError("执行源码含替身，不能确认恢复兼容性。")
                if file.name == "__pycache__":
                    continue
                if file.is_dir():
                    pending.append(file)
                elif file.is_file() and file.suffix == ".py":
                    paths.append(file)
                elif not file.is_file():
                    raise SourceCompatibilityError("执行源码含特殊文件，不能确认恢复兼容性。")
    paths += [backend / name for name in ["requirements.lock", "requirements.txt", "alembic.ini"]]
    if not (backend / "app/main.py").is_file():
        raise SourceCompatibilityError("执行源码缺少启动文件，请保留原环境。")
    digest = hashlib.sha256()
    for file in sorted(paths):
        if file.is_symlink() or not file.is_file():
            raise SourceCompatibilityError("执行源码缺少必要文件或含替身，未继续。")
        name = file.relative_to(backend).as_posix().encode("utf-8")
        content = hashlib.sha256(file.read_bytes()).digest()
        digest.update(str(len(name)).encode("ascii") + b":" + name + content)
    return {"format": "synplex.backend-source/1", "sha256": digest.hexdigest(), "files": len(paths)}


def verify_source(backend: Path, saved):
    identity = saved.get("sourceIdentity")
    if not isinstance(identity, dict) or identity.get("format") != "synplex.backend-source/1":
        raise SourceCompatibilityError("旧环境缺少执行源码指纹，不能自动认定兼容。请保留原环境和原版本备份，在全新目录重新准备；不要手工补造指纹。")
    if source_identity(backend) != identity:
        raise SourceCompatibilityError("执行源码与原记录不同，未启动或恢复。请使用原版本安装包，不要覆盖现有数据。")
    return identity


def runtime_identity(directory: Path | None = None):
    """Bind our adapter, tools, migrations and parser bridge, not just vendor code."""
    directory = Path(__file__).parent if directory is None else directory
    if directory.is_symlink() or not directory.is_dir():
        raise SourceCompatibilityError("执行适配程序位置不安全，请保留原版本。")
    paths = []
    for file in sorted(directory.iterdir()):
        if file.name == "__pycache__":
            continue
        if file.is_symlink():
            raise SourceCompatibilityError("执行适配程序含替身，不能确认版本。")
        if file.is_dir():
            raise SourceCompatibilityError("执行适配程序目录结构已有变化，请先核对版本。")
        if file.suffix in {".py", ".mjs"}:
            if not file.is_file():
                raise SourceCompatibilityError("执行适配程序含特殊文件，未继续。")
            paths.append(file)
    required = {"source_identity.py", "engine_runtime.py", "local_runner.py", "engine_recovery.py", "read_document.mjs"}
    if not required.issubset({p.name for p in paths}):
        raise SourceCompatibilityError("执行适配程序不完整，请保留原安装包。")
    digest = hashlib.sha256()
    for file in paths:
        name = file.name.encode("utf-8")
        digest.update(str(len(name)).encode("ascii") + b":" + name + hashlib.sha256(file.read_bytes()).digest())
    return {"format": "synplex.engine-runtime-source/1", "sha256": digest.hexdigest(), "files": len(paths)}


def verify_runtime(saved, directory: Path | None = None):
    identity = saved.get("runtimeIdentity")
    if not isinstance(identity, dict) or identity.get("format") != "synplex.engine-runtime-source/1":
        raise SourceCompatibilityError("旧环境缺少执行适配程序指纹，不能自动升级。请保留原环境并使用原版本；不要手工补造指纹。")
    if runtime_identity(directory) != identity:
        raise SourceCompatibilityError("执行适配程序与准备环境时的版本不同，未启动或恢复。请使用原版本安装包；升级需先核对兼容性，不能覆盖现有数据。")
    return identity
