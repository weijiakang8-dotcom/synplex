"""Explicitly transfer one unchanged, IDLE joint restoration on this Mac.

Run with the product's evaluated private Python environment. Both original
directories remain as authority witnesses: do not remove, move or edit them.
Pending/unknown work and broker messages are refused, not replayed. A transfer
interrupted after retirement resumes ONLY the same saved intent and target.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
from engine_runtime import configuration, startup_lease, ensure_execution_allowed, ensure_database_idle
from engine_recovery import verify_product, files, database_state, settled
from engine_reconcile import restored_identity, workspace_bindings, inspect_database
from handoff_state import (PROTOCOL, RETIRED, COMPLETE, durable_json, private_directory,
                           validate_proof, proof_for_target)
from handoff_queue import inspect_queue_copy
from private_infrastructure import read_private, OwnedInfrastructure
from workspace_maintenance import workspace_maintenance


def origin_paths(snapshot, manifest, target):
    roots = [private_directory(manifest[name]) for name in ["workspace", "engine"]]
    for path in [*roots, private_directory(target / "workspace"), private_directory(target / "engine")]:
        if path == snapshot or path in snapshot.parents or snapshot in path.parents:
            raise RuntimeError("原目录、备份和恢复目录必须分别保留，不能互相嵌套。")
    return roots


def intent_for(snapshot, target, manifest):
    original_engine = Path(manifest["engine"])
    source, _, original = configuration(original_engine)
    saved, _, restored = configuration(target / "engine")
    if source.get("handoffProtocol") != PROTOCOL or saved.get("handoffProtocol") != PROTOCOL:
        raise RuntimeError("原环境没有这版接管保护，请保留原安装包；不能给旧环境手工补造记录。")
    if (original_engine / "recovery.json").exists():
        raise RuntimeError("本版先处理首次联合恢复；已经接管过的实例需单独核对，不能形成不明接管链。")
    proof = {"format": PROTOCOL, "id": str(uuid.uuid4()), "snapshot": str(snapshot),
             "snapshotSha256": hashlib.sha256((snapshot / "product-snapshot.json").read_bytes()).hexdigest(),
             "source": {"workspace": manifest["workspace"], "engine": manifest["engine"],
                        "engineId": original["id"], "infrastructureId": source["infrastructureId"]},
             "target": {"workspace": str(target / "workspace"), "engine": str(target / "engine"),
                        "engineId": restored["id"], "infrastructureId": saved["infrastructureId"]}}
    file = target / "handoff-intent.json"
    if file.exists():
        intent = read_private(file)
        previous = validate_proof(intent.get("proof"))
        proof["id"] = previous["id"]
        if intent != {"proof": proof, "python": sys.executable}:
            raise RuntimeError("已有不同的接续意图，不能改换目标或覆盖原记录。")
    else:
        intent = {"proof": validate_proof(proof), "python": sys.executable}
        # A different candidate must not reserve or replace an already-retired original.
        for path in [Path(manifest["engine"]), Path(manifest["workspace"])]:
            if (path / RETIRED).exists():
                raise RuntimeError("原实例已经交给另一份恢复副本，不能再次接管。")
        durable_json(file, intent, once=True)
    return intent


def check_original(proof, snapshot):
    engine = Path(proof["source"]["engine"])
    saved, infra, data = configuration(engine)
    if saved != read_private(snapshot / "engine/original-startup.json") or infra != read_private(snapshot / "engine/original-infrastructure.json"):
        raise RuntimeError("原执行设置在备份后已变化，请保留新内容，不能接管旧副本。")
    if (engine / RETIRED).exists():
        if read_private(engine / RETIRED) != proof:
            raise RuntimeError("原实例已有另一份接管记录，未覆盖。")
    else:
        ensure_execution_allowed(engine)
    if files(engine / "engine") != files(snapshot / "engine/engine"):
        raise RuntimeError("原文件或队列在备份后有变化，请保留新内容，不能接管旧副本。")
    return saved, infra, data


def inspect_idle_database(infra, data, expected, bindings=None):
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        if database_state(data) != expected:
            raise RuntimeError("数据库在备份后已有变化，不能接管旧副本。")
        ensure_database_idle(data)
        if bindings is not None:
            result = inspect_database(data, bindings)
            for row in result["tasks"]:
                if row["state"] != "original_task_verified" or row["engineStatus"] not in {"completed", "failed", "rolled_back"}:
                    raise RuntimeError("仍有原任务身份或结果未确认，执行器保持停用，不会重发。")
        if database_state(data) != expected:
            raise RuntimeError("核对期间数据库发生变化，不能继续接管。")
    finally:
        owned.close()


def database_and_identity_checks(proof, snapshot, target, manifest, *, node):
    saved, infra, data = check_original(proof, snapshot)
    restored_identity(snapshot, target, node=node, handoff=proof)
    target_saved, target_infra, target_data = configuration(target / "engine")
    # Once settings have been prepared, the same original bindings can still be
    # read. They are NEVER rewritten to look like newly submitted operations.
    prepared = (target / "workspace/executors.json").exists()
    bindings = workspace_bindings(snapshot, target, manifest, node=node,
                                 handoff_intent=target / "handoff-intent.json" if prepared else None)
    expected = read_private(snapshot / "engine/engine-snapshot.json")["database"]
    inspect_idle_database(infra, data, expected)
    inspect_idle_database(target_infra, target_data, expected, bindings["bindings"])
    inspect_queue_copy(snapshot / "engine", saved, data)
    # Both sets of engine files remain byte-identical, except the two connection
    # files deliberately remapped during restore. No original broker is started.
    check_original(proof, snapshot)
    restored_identity(snapshot, target, node=node, handoff=proof)
    return target_saved, target_data, len(bindings["bindings"])


def finish_transfer(proof, target, source_guard, target_guard, *, snapshot, node, manifest, leases):
    intent = target / "handoff-intent.json"
    source_guard.request("handoff-audit", intent)
    target_guard.request("handoff-audit", intent)
    for root, lease in leases:
        settled(root, lease)
    _, _, count = database_and_identity_checks(proof, snapshot, target, manifest, node=node)
    # Retirement is durable and never silently rolled back. After this point a
    # crash leaves the original disabled, and only this exact intent can resume.
    durable_json(Path(proof["source"]["engine"]) / RETIRED, proof, once=True)
    durable_json(Path(proof["source"]["workspace"]) / RETIRED, proof, once=True)
    target_guard.request("handoff-prepare", intent)
    engine_record = read_private(target / "engine/recovery.json")
    durable_json(target / "engine/recovery.json", {**engine_record, "executorsEnabled": True, "handoff": proof,
                 "notice": "闲置实例已核对接管；原任务不自动重做。原目录作为接管凭据保留。"})
    product_record = read_private(target / "product-recovery.json")
    durable_json(target / "product-recovery.json", {**product_record, "executorsEnabled": True, "handoff": proof,
                 "remoteIdentitiesRemapped": False, "nextAction": "从恢复目录打开Synplex。原记录、成果和费用保留，不会自动重做历史任务。"})
    # No runtime admits a true flag before this final joint receipt exists.
    source_guard.request("handoff-audit", intent)
    target_guard.request("handoff-audit", intent)
    source_guard.request("check-unused")
    target_guard.request("check-unused")
    for root, lease in leases:
        settled(root, lease)
    durable_json(target / COMPLETE, proof, once=True)
    ensure_execution_allowed(target / "engine")
    return {"format": "synplex.idle-handoff-result/1", "status": "completed", "handoffId": proof["id"],
            "executorsEnabled": True, "originalRetired": True, "originalBindingsVerified": count,
            "bindingsChanged": False, "originalQueueStarted": False, "workerStarted": False,
            "taskReplay": False, "modelCalls": 0,
            "notice": "闲置实例已接管。请保留原目录作为接管凭据；本次没有启动任务或产生模型费用。"}


def activate_idle_product(snapshot, target, *, node):
    snapshot, target = private_directory(snapshot), private_directory(target)
    manifest = verify_product(snapshot, node=node)
    workspace, engine = origin_paths(snapshot, manifest, target)
    with ExitStack() as stack:
        source_lease = stack.enter_context(startup_lease(engine))
        target_lease = stack.enter_context(startup_lease(target / "engine"))
        source_guard = stack.enter_context(workspace_maintenance(node, workspace))
        target_guard = stack.enter_context(workspace_maintenance(node, target / "workspace"))
        intent = intent_for(snapshot, target, manifest)
        proof = intent["proof"]
        if (target / COMPLETE).exists():
            proof_for_target(target / "engine", proof, "engine")
            ensure_execution_allowed(target / "engine")
            return {"format": "synplex.idle-handoff-result/1", "status": "already_completed", "handoffId": proof["id"],
                    "modelCalls": 0, "taskReplay": False, "bindingsChanged": False}
        # Engine occupancy is covered by both lifetime leases. Workspace guards
        # also reject unrelated file holders and retain the same locks throughout.
        return finish_transfer(proof, target, source_guard, target_guard, snapshot=snapshot, node=node, manifest=manifest,
                               leases=[(engine, source_lease), (target / "engine", target_lease)])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("restored", type=Path)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--human", action="store_true", help="Show a short Chinese result for the local recovery entry")
    args = parser.parse_args()
    try:
        result = activate_idle_product(args.snapshot, args.restored, node=args.node)
        print((result.get("notice") or "这份副本已经核对完成，没有重复接管或重做任务。") if args.human else json.dumps(result, ensure_ascii=False))
    except Exception:
        print("接管未完成。保留原目录、备份和恢复目录，按同一条命令核对并续接；不要删除停用记录、改换副本或重复发送任务。", file=sys.stderr)
        sys.exit(1)
