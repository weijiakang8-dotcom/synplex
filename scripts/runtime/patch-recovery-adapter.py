"""Apply only the evaluated r4 recovery/relay adapter changes offline.

Not a general engine upgrade or a way to bless arbitrary source fingerprints.
Requires two verified immutable releases, exact known recovery/relay changes,
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
# relay_recovery.py is an evaluated addition, not an existing file in r4.
EVALUATED = {'engine_runtime.py': {'previous': '9b88b1bd3ea8068fccc15ea800bba69513d689b37839ba2360fec91f586e46e5', 'candidate': 'c5997ebc92f18408428514087c8b896da5d41e32b63f990d4c97c5b699a32532'}, 'private_infrastructure.py': {'previous': '3f64e6f2da5f38fdd7da854cd1c98830cc39efc6b88589fd26e6cb3e7c869d27', 'candidate': 'f69d46716d18b86cc24de9cffce164297be486dfb6c934e71984566ed1e5df99'}, 'engine_recovery.py': {'previous': '47b943f12b199d999bec4231a2688e7ee90e029ca367a7343e9aa97b317ae005', 'candidate': 'ff6d547c47163aac09823a0de5d6a9edf891ec8029778fffa5c42a27b11ac7db'}, 'engine_reconcile.py': {'previous': '38c5421ab9352a97474fd72b0b7dfaf9196700fb46d5cdb0de66ae0496e11f4a', 'candidate': 'f79a4d5135ec4e1188bb7477bd08e6d6869649d59c7b95ddb620bd026803d581'}, 'model_relay_contract.py': {'previous': 'c24b69597c1b71fdff827f11c22930c414706b5a2aef1255fae69d0cfe0f1175', 'candidate': '18b34a1bd1dec3a7601948f749764a8b645d9c6edb3d5011d8aa5bed9c8ef581'}, 'relay_recovery.py': {'previous': None, 'candidate': 'd3a8a9ef4e1af20ab81bab241267ff0bf54e899f0d0c3dbc2cc673d6864e21f0'}}

def evaluated_patch(previous, candidate):
    def inventory(directory):
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError('需要完整的独立发行包。')
        result = {}
        for file in directory.iterdir():
            if file.name == '__pycache__':
                continue
            if file.is_symlink() or not file.is_file():
                raise RuntimeError('适配程序结构变化，不在本次修复范围内。')
            result[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
        return result
    before, after = inventory(previous), inventory(candidate)
    changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
    actual = {key: {'previous': before.get(key), 'candidate': after.get(key)} for key in sorted(changed)}
    if actual != EVALUATED:
        raise RuntimeError('只允许已评估的恢复适配变更，其他变更需另行迁移。')
    return actual


def private_atomic(path, value):
    temporary = path.with_name(path.name + '.recovery-adapter.tmp')
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
    previous, candidate, root, snapshot = [getattr(args, key).resolve() for key in
                                          ['previous', 'candidate', 'engine', 'snapshot']]
    for release in [previous, candidate]:
        check = subprocess.run([str(args.node), str(ROOT / 'scripts/runtime/release.mjs'), 'verify', str(release)],
                               capture_output=True, timeout=40)
        if check.returncode:
            raise RuntimeError('发行包核对失败，保留原环境。')
    patch = evaluated_patch(previous / 'integrations/agenthub', candidate / 'integrations/agenthub')
    # Load the active trusted code. Its compatibility checks remain intact.
    active = candidate if args.rollback else previous
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
    original_receipt = root / 'recovery-adapter-migration.json'
    receipt = root / ('recovery-adapter-rollback.json' if args.rollback else 'recovery-adapter-migration.json')
    if receipt.exists():
        raise RuntimeError('此修复已有记录，请先核对原结果，不会重复迁移。')
    with startup_lease(root) as lease:
        settled(root, lease)
        saved, infra, data = configuration(root)
        if saved != read_private(snapshot / 'original-startup.json'):
            raise RuntimeError('启动设置与备份不一致，未修改。')
        if files(root / 'engine') != files(snapshot / 'engine'):
            raise RuntimeError('引擎文件与备份不一致，未修改。')
        destination = previous if args.rollback else candidate
        verify_runtime(saved, active / 'integrations/agenthub')
        next_saved = {**saved, 'runtimeIdentity': runtime_identity(destination / 'integrations/agenthub')}
        if args.rollback:
            original = read_private(original_receipt)
            if (original.get('status') != 'applied' or original.get('after') != saved
                    or original.get('before') != next_saved or original.get('patch') != patch):
                raise RuntimeError('原修复记录不一致，未回退。')
        owned = OwnedInfrastructure(infra)
        try:
            owned.start_database()
            ensure_database_idle(data)
            if database_state(data) != manifest['database']:
                raise RuntimeError('数据库与原备份不一致，未修改。')
            owned.start_queue(Path(saved['valkey']), root / 'engine')
            queue_check.ensure_queue_idle(data)
            if args.rollback:
                # The original guard cannot start with retained disabled
                # evaluation messages. Refuse an unusable downgrade rather
                # than deleting those messages or pretending rollback works.
                original_module = importlib.util.spec_from_file_location('original_queue_check', previous / 'integrations/agenthub/engine_runtime.py')
                original_guard = importlib.util.module_from_spec(original_module)
                original_module.loader.exec_module(original_guard)
                original_guard.ensure_queue_idle(data)
            # No API/worker is started, so there is no admission or task replay.
            record = {'format': 'synplex.recovery-adapter-migration/1', 'status': 'prepared',
                      'previous': str(previous), 'candidate': str(candidate), 'snapshot': str(snapshot),
                      'patch': patch, 'before': saved, 'after': next_saved, 'modelCalls': 0}
            private_atomic(receipt, record)
            private_atomic(root / 'engine-startup.json', next_saved)
            verify_runtime(next_saved, destination / 'integrations/agenthub')
            private_atomic(receipt, {**record, 'status': 'applied'})
        finally:
            owned.close()
    print('恢复适配修复已离线迁移；原启动设置和数据库备份保留，没有执行任务或调用模型。')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['previous', 'candidate', 'engine', 'snapshot', 'node']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--rollback', action='store_true')
    try:
        apply(parser.parse_args())
    except Exception:
        print('恢复适配迁移未能完成；请核对原迁移记录、备份和运行版本，不要重新执行历史任务。', file=sys.stderr)
        sys.exit(1)
