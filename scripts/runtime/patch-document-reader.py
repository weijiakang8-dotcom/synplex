"""Apply ONE evaluated, data-compatible document-reader adapter change offline.

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
RUNTIME_BEFORE = '354f705aa7fd2ddb1fa75cbfcb874737fb1c785692ab54ae260846b3c59959bd'
RUNTIME_AFTER = '9b88b1bd3ea8068fccc15ea800bba69513d689b37839ba2360fec91f586e46e5'
OLD_LOOP = '    for name in ("general", "analysis", "writing"):'
NEW_LOOP = '    for name in ("general", "analysis", "writing", "document"):'
OLD_BIND = '        CAPABILITIES[name] = replace(capability, tools=tools + added)'
NEW_BIND = '''        # Document revisions need the same scoped, fingerprint-checked source
        # reader. Do not grant code execution or spreadsheet tools here.
        CAPABILITIES[name] = replace(capability, tools=tools + ((read_task_file,) if name == "document" else added))'''


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
            result[file.name] = file.read_bytes()
        return result
    before, after = inventory(previous), inventory(candidate)
    changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
    if changed != {'task_tools.py', 'engine_runtime.py'}:
        raise RuntimeError('只允许本次已评估的旧稿读取修复，其他引擎变更需另行迁移。')
    if (hashlib.sha256(before['engine_runtime.py']).hexdigest() != RUNTIME_BEFORE
            or hashlib.sha256(after['engine_runtime.py']).hexdigest() != RUNTIME_AFTER):
        raise RuntimeError('队列核对修复与已评估版本不符，未接受新的指纹。')
    prior = before['task_tools.py'].decode()
    if prior.count(OLD_LOOP) != 1 or prior.count(OLD_BIND) != 1:
        raise RuntimeError('原版工具结构不符，未修改任何数据。')
    expected = prior.replace(OLD_LOOP, NEW_LOOP).replace(OLD_BIND, NEW_BIND).encode()
    if after['task_tools.py'] != expected:
        raise RuntimeError('修复字节不符合已评估转换，未接受新的指纹。')
    return {key: {'previous': hashlib.sha256(before[key]).hexdigest(),
                  'candidate': hashlib.sha256(after[key]).hexdigest()} for key in sorted(changed)}


def private_atomic(path, value):
    temporary = path.with_name(path.name + '.document-reader.tmp')
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
    original_receipt = root / 'document-reader-migration.json'
    receipt = root / ('document-reader-rollback.json' if args.rollback else 'document-reader-migration.json')
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
            record = {'format': 'synplex.document-reader-migration/1', 'status': 'prepared',
                      'previous': str(previous), 'candidate': str(candidate), 'snapshot': str(snapshot),
                      'patch': patch, 'before': saved, 'after': next_saved, 'modelCalls': 0}
            private_atomic(receipt, record)
            private_atomic(root / 'engine-startup.json', next_saved)
            verify_runtime(next_saved, destination / 'integrations/agenthub')
            private_atomic(receipt, {**record, 'status': 'applied'})
        finally:
            owned.close()
    print('旧稿读取修复已离线迁移；原启动设置和数据库备份保留，没有执行任务或调用模型。')


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
