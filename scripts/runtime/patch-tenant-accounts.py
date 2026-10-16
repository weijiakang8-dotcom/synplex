"""Apply the evaluated d5b444b -> tenant account adapter change offline.

Not a general engine upgrade or a way to bless arbitrary source fingerprints.
Requires two verified immutable releases, exact known reader/queue changes,
the original engine snapshot, stopped services, and an empty queue/database.
Only engine-startup.json changes; no task, key, source or database row changes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
# Explicitly reviewed d5b444b -> tenant identity adapter bytes. This is not
# a general fingerprint refresh; any other addition/edit/deletion is rejected.
APPROVED = {'approval_delivery.py': ('287d9e97c4291ed9b42b3bce07717f18b88779b73cb234e5df9a795b3d2d0605', '386a69222e790ae607790d878d97edc09495fbc4e30f7259bafae4d4bd139ba4'), 'engine_reconcile.py': ('f79a4d5135ec4e1188bb7477bd08e6d6869649d59c7b95ddb620bd026803d581', '2a07062574c7f2c015fe74c000cbe684e39c3f8be04070c055ba3f4495f2e4ee'), 'input_delivery.py': ('41a896d08a926f85f7252936e6330ad3a6ea18424221b76e406baa82299cadc8', '3a6f07f481b33abda4ff27ade0f3ccac2669e821a21e5ae60c702166b8f80de5'), 'local_runner.py': ('88eb0aba1b206240a02a0256334307c51e7877c43cb4229f54f82a1ff891be08', '0bab14baace32d593daea031f4272ee511b8e2d614f7b8c714173a3f559bbd34'), 'model_binding.py': ('5187622cdcafad647323c7a2eb3ca6a88bf73d12e3e5803aae0819fea5f4c114', '4c3637e4e8a6a74c0f339f029ba2feb3690e1c10bb41527b95ed3236da0648d1'), 'submission_delivery.py': ('b173fb820433640428d4a30e764afedf4abbf12afd0f0c6ca2be1fc1d27d3a65', 'ee3f2370b8316ea860f7f35fca498627900196384935ba0a7909e47a58c2b72f'), 'usage_evidence.py': ('cc64c5b95e9d5a64b204b898a59d1c1967d720266078263f2fd3f1cf5d98c374', 'f476adf02e376d1f029bee32a60818623fe75e79b0cee2f1e644f0553b2ac595'), 'tenant_identity.py': (None, '05a56c056514f2e86407090d8b7682b853487f1c70edb4ebf5f5b23de36f74fc')}


def evaluated_patch(previous, candidate):
    def inventory(directory):
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError('需要完整的独立发行包。')
        result = {}
        for file in directory.iterdir():
            if file.name == '__pycache__':
                continue
            if file.is_symlink() or not file.is_file():
                raise RuntimeError('执行适配程序结构变化，未迁移。')
            result[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
        return result
    before, after = inventory(previous), inventory(candidate)
    changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
    if changed != set(APPROVED):
        raise RuntimeError('变更超出已评估的账号隔离适配范围，未迁移。')
    for key, (old, new) in APPROVED.items():
        if before.get(key) != old or after.get(key) != new:
            raise RuntimeError('执行适配字节与已评估版本不同，未迁移。')
    return {key: {'previous': old, 'candidate': new} for key, (old, new) in APPROVED.items()}


def private_atomic(path, value):
    temporary = path.with_name(path.name + '.tenant-accounts.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as file:
        json.dump(value, file, ensure_ascii=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def apply(args):
    if args.rollback:
        raise RuntimeError('不能让旧程序读取新增账号资料。请使用完整升级前联合备份恢复，并保留升级后资料。')
    previous, candidate, root, snapshot = [getattr(args, key).resolve() for key in
                                          ['previous', 'candidate', 'engine', 'snapshot']]
    for release in [previous, candidate]:
        check = subprocess.run([str(args.node), str(ROOT / 'scripts/runtime/release.mjs'), 'verify', str(release)],
                               capture_output=True, timeout=40)
        if check.returncode:
            raise RuntimeError('发行包核对失败，保留原环境。')
    patch = evaluated_patch(previous / 'integrations/agenthub', candidate / 'integrations/agenthub')
    # Load the active trusted code. Its compatibility checks remain intact.
    active = previous
    sys.path.insert(0, str(active / 'integrations/agenthub'))
    from engine_runtime import configuration, startup_lease, ensure_database_idle
    import importlib.util
    module = importlib.util.spec_from_file_location('evaluated_queue_check', candidate / 'integrations/agenthub/engine_runtime.py')
    queue_check = importlib.util.module_from_spec(module)
    module.loader.exec_module(queue_check)
    from engine_recovery import verify_snapshot, files, settled, database_state
    from private_infrastructure import OwnedInfrastructure, read_private
    from source_identity import verify_runtime, runtime_identity
    manifest = verify_snapshot(snapshot)
    if Path(manifest['source']).resolve() != root:
        raise RuntimeError('备份不属于这份执行环境。')
    receipt = root / 'tenant-accounts-migration.json'
    if receipt.exists():
        raise RuntimeError('此修复已有记录，请先核对原结果，不会重复迁移。')
    with startup_lease(root) as lease:
        settled(root, lease)
        saved, infra, data = configuration(root)
        if saved != read_private(snapshot / 'original-startup.json'):
            raise RuntimeError('启动设置与备份不一致，未修改。')
        if files(root / 'engine') != files(snapshot / 'engine'):
            raise RuntimeError('引擎文件与备份不一致，未修改。')
        destination = candidate
        verify_runtime(saved, active / 'integrations/agenthub')
        next_saved = {**saved, 'runtimeIdentity': runtime_identity(destination / 'integrations/agenthub')}
        owned = OwnedInfrastructure(infra)
        try:
            owned.start_database()
            ensure_database_idle(data)
            if database_state(data) != manifest['database']:
                raise RuntimeError('数据库与原备份不一致，未修改。')
            owned.start_queue(Path(saved['valkey']), root / 'engine')
            queue_check.ensure_queue_idle(data)
            # No API/worker is started, so there is no admission or task replay.
            record = {'format': 'synplex.tenant-accounts-migration/1', 'status': 'prepared',
                      'previous': str(previous), 'candidate': str(candidate), 'snapshot': str(snapshot),
                      'patch': patch, 'before': saved, 'after': next_saved, 'modelCalls': 0}
            private_atomic(receipt, record)
            private_atomic(root / 'engine-startup.json', next_saved)
            verify_runtime(next_saved, destination / 'integrations/agenthub')
            private_atomic(receipt, {**record, 'status': 'applied'})
        finally:
            owned.close()
    print('账号隔离适配已离线迁移；原启动设置和数据库备份保留，没有执行任务或调用模型。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['previous', 'candidate', 'engine', 'snapshot', 'node']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--rollback', action='store_true')
    try:
        apply(parser.parse_args())
    except Exception:
        print('修复未能完成；请核对原迁移记录、备份和运行版本，不要重新执行历史任务。', file=sys.stderr)
        sys.exit(1)
