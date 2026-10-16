"""Apply only the evaluated selected-output worker adapter, offline.

Two immutable releases and an idle, verified original snapshot are required.
No model call, task replay, quota reset or data mutation is performed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True  # Verified releases must remain byte-for-byte immutable.

ROOT = Path(__file__).resolve().parents[2]
EVALUATED = {'local_runner.py': {'previous': '0bab14baace32d593daea031f4272ee511b8e2d614f7b8c714173a3f559bbd34', 'candidate': '6af108b4f0e1feb26e9fdfed087026835c44a85c7083e7fd58c277bf57464f53'}, 'worker_output.py': {'previous': None, 'candidate': 'f3c86e9b3c4cd0dea126f7d40267a38ac8ccc6f52a8efc1bba88c2a1a8f2f4c4'}}
DOCUMENT_PATCH = {
    'worker_output.py': {'previous': EVALUATED['worker_output.py']['candidate'],
                         'candidate': 'fb8fdcb35d5af300cb3899cbf36ff376b640ca5862ef3711215d667f85d2c837'},
    'document_delivery.py': {'previous': None,
                             'candidate': '5d5e4b0b3607592f8868f9880fe4b37a0e2e30d11f812d53442abf47382d8ce6'},
}
CUMULATIVE = {**EVALUATED, 'document_delivery.py': DOCUMENT_PATCH['document_delivery.py'],
              'worker_output.py': {'previous': None, 'candidate': DOCUMENT_PATCH['worker_output.py']['candidate']}}
STEP_PATCH = {
    'worker_output.py': {'previous': DOCUMENT_PATCH['worker_output.py']['candidate'],
                         'candidate': '86ae81026bf544fbcbf58881554902c22e9e4ce67eaf9169758cf1c514d1293b'},
    'step_inputs.py': {'previous': None,
                       'candidate': '0baad5ddb854c4188d61a83c29c70e7f988befaf9bbac8a0ac5785273cd74c5a'},
}
STEP_COMPLETE = {**CUMULATIVE, 'step_inputs.py': STEP_PATCH['step_inputs.py'],
            'worker_output.py': {'previous': None, 'candidate': STEP_PATCH['worker_output.py']['candidate']}}

REVISION_PATCH = {'document_delivery.py': {'previous': DOCUMENT_PATCH['document_delivery.py']['candidate'], 'candidate': '9bd8f5766e7298f002359ea59bab9ed02b48032a43e13f7da6ca074b847bdf63'}}
REVISION_COMPLETE = {**STEP_COMPLETE, 'document_delivery.py': {'previous': None, 'candidate': REVISION_PATCH['document_delivery.py']['candidate']}}
MANUSCRIPT_PATCH = {'document_delivery.py': {'previous': REVISION_PATCH['document_delivery.py']['candidate'], 'candidate': 'faea5d25178d22457e6e998fa83cbab4a50fca3d8d2a276d0e5239a4843b4d9b'}}
COMPLETE = {**STEP_COMPLETE, 'document_delivery.py': {'previous': None, 'candidate': MANUSCRIPT_PATCH['document_delivery.py']['candidate']}}

COMPLETION_PATCH = {'document_delivery.py': {'previous': MANUSCRIPT_PATCH['document_delivery.py']['candidate'], 'candidate': '527b63c67cb89ee1c95ec2db603b06981ef4720af4520d3c649fc4f9378813cf'},
                    'document_completion.py': {'previous': None, 'candidate': '038228e944e9cb8668c2498761a2f43e99302f4f0178f21a8b220f8822178e45'}}
LATEST_COMPLETE = {**COMPLETE, 'document_delivery.py': {'previous': None, 'candidate': COMPLETION_PATCH['document_delivery.py']['candidate']},
                   'document_completion.py': COMPLETION_PATCH['document_completion.py']}
FORMAT_COMPLETION_PATCH = {'document_completion.py': {'previous': COMPLETION_PATCH['document_completion.py']['candidate'],
    'candidate': '99ff5586ee07c19bca210f3e0fc5a571c97f674c6226cd2cf849b7b3827e1ddc'}}
FORMAT_COMPLETION_COMPLETE = {**LATEST_COMPLETE, 'document_completion.py': {'previous': None,
    'candidate': FORMAT_COMPLETION_PATCH['document_completion.py']['candidate']}}
LITERAL_COMPLETION_PATCH = {'document_completion.py': {'previous': FORMAT_COMPLETION_PATCH['document_completion.py']['candidate'],
    'candidate': '16f4e6ce6f4b338388a29950b553e35db589ffea53d210cf9e9a2cdd23eca4aa'}}
LITERAL_COMPLETION_COMPLETE = {**FORMAT_COMPLETION_COMPLETE, 'document_completion.py': {'previous': None,
    'candidate': LITERAL_COMPLETION_PATCH['document_completion.py']['candidate']}}
UPGRADE_GUARD_PATCH = {'engine_runtime.py': {
    'previous': 'c5997ebc92f18408428514087c8b896da5d41e32b63f990d4c97c5b699a32532',
    'candidate': 'b033d5741988f9f111eaecbfb29d279b007ae4dc853e1ef990ff4030f43f0fa2'}}
UPGRADE_GUARD_FROM_FORMAT = {**LITERAL_COMPLETION_PATCH, **UPGRADE_GUARD_PATCH}
UPGRADE_GUARD_COMPLETE = {**LITERAL_COMPLETION_COMPLETE, **UPGRADE_GUARD_PATCH}
REFERENCE_FEEDBACK_PATCH = {
    'document_completion.py': {'previous': '16f4e6ce6f4b338388a29950b553e35db589ffea53d210cf9e9a2cdd23eca4aa',
        'candidate': 'fdf155b1100c09df475180f26455c6ed8ace2c107f4949efd3069901551c9dcb'},
    'document_delivery.py': {'previous': '527b63c67cb89ee1c95ec2db603b06981ef4720af4520d3c649fc4f9378813cf',
        'candidate': '89ddf6a36e801942d8bab677388702c88d1650688f5c0568de1bdad43b2916e5'}}
REFERENCE_FEEDBACK_COMPLETE = {**UPGRADE_GUARD_COMPLETE,
    **{name: {'previous': None, 'candidate': change['candidate']} for name, change in REFERENCE_FEEDBACK_PATCH.items()}}

FILE_INSPECTION_PATCH = {'document_delivery.py': {'previous': REFERENCE_FEEDBACK_PATCH['document_delivery.py']['candidate'], 'candidate': '47085fe59693e3f9f8211bb682cd9497d472e2a2fb0fca69b74c41282a1daef7'}}
FILE_INSPECTION_COMPLETE = {**REFERENCE_FEEDBACK_COMPLETE, 'document_delivery.py': {'previous': None, 'candidate': FILE_INSPECTION_PATCH['document_delivery.py']['candidate']}}

DOCUMENT_PLANNING_PATCH = {'document_delivery.py': {'previous': FILE_INSPECTION_PATCH['document_delivery.py']['candidate'], 'candidate': '5b51141a89d10393c5b0a9406a5f45a2032ada9c342b909a77c14c309325a193'}}
DOCUMENT_PLANNING_COMPLETE = {**FILE_INSPECTION_COMPLETE, 'document_delivery.py': {'previous': None, 'candidate': DOCUMENT_PLANNING_PATCH['document_delivery.py']['candidate']}}

DOCUMENT_PREFLIGHT_PATCH = {'document_delivery.py': {'previous': DOCUMENT_PLANNING_PATCH['document_delivery.py']['candidate'], 'candidate': '64df4f2593c1d46c4c9af94a1e8973bd4bca734a6d32474d4e25dbcde99de7a0'},
    'document_completion.py': {'previous': REFERENCE_FEEDBACK_PATCH['document_completion.py']['candidate'], 'candidate': '74c2df73577ccc37e7935f4d322873496a3219694278d938983ec5c17f9cad31'}}
DOCUMENT_PREFLIGHT_COMPLETE = {**DOCUMENT_PLANNING_COMPLETE, **{name: {'previous': None, 'candidate': change['candidate']} for name, change in DOCUMENT_PREFLIGHT_PATCH.items()}}

SOURCE_TITLE_PATCH = {'document_delivery.py': {'previous': DOCUMENT_PREFLIGHT_PATCH['document_delivery.py']['candidate'], 'candidate': '7d4fe10b2ef6e079433177ec091c85976d5278d467e2e0bcebd307c55165565b'}}
SOURCE_TITLE_COMPLETE = {**DOCUMENT_PREFLIGHT_COMPLETE, 'document_delivery.py': {'previous': None, 'candidate': SOURCE_TITLE_PATCH['document_delivery.py']['candidate']}}

SCOPED_MENU_PATCH = {'document_completion.py': {'previous': DOCUMENT_PREFLIGHT_PATCH['document_completion.py']['candidate'], 'candidate': 'f89674ee81088fe3f52219d3aaba5eb209f074ef998831e422635767610c5947'}}
SCOPED_MENU_COMPLETE = {**SOURCE_TITLE_COMPLETE, 'document_completion.py': {'previous': None, 'candidate': SCOPED_MENU_PATCH['document_completion.py']['candidate']}}

DOCUMENT_AGENT_PATCH = {'document_completion.py': {'previous': SCOPED_MENU_PATCH['document_completion.py']['candidate'], 'candidate': '5c03097a1e9525bbb70ea857bd32b8878b3b251e22cf19f133df5015149c406e'}}
DOCUMENT_AGENT_COMPLETE = {**SCOPED_MENU_COMPLETE, 'document_completion.py': {'previous': None, 'candidate': DOCUMENT_AGENT_PATCH['document_completion.py']['candidate']}}

DOCUMENT_SOURCE_PATCH = {'document_completion.py': {'previous': DOCUMENT_AGENT_PATCH['document_completion.py']['candidate'], 'candidate': '42c21761404d2c9dca0d47974fa3877439bb1397f14f97301b0a8b85a00ea337'}}
DOCUMENT_SOURCE_COMPLETE = {**DOCUMENT_AGENT_COMPLETE, 'document_completion.py': {'previous': None, 'candidate': DOCUMENT_SOURCE_PATCH['document_completion.py']['candidate']}}

DOCUMENT_BOUNDARIES_PATCH = {'document_delivery.py': {'previous': '7d4fe10b2ef6e079433177ec091c85976d5278d467e2e0bcebd307c55165565b', 'candidate': '8de452480bcc1d2c6e0c0064c420ba8cf742827c745b794922c95214ebcc42a9'}, 'clarification_gate.py': {'previous': None, 'candidate': '8089018aab7111ab41c713415e1d28a497482cafc335c3e226ed3fcc843959b6'}, 'verification_inputs.py': {'previous': None, 'candidate': '615057799c0f6b7f019aaffa7923c1a80f0af83bd0e35695885631fa221df65c'}}
DOCUMENT_BOUNDARIES_COMPLETE = {**DOCUMENT_SOURCE_COMPLETE, **{name: {"previous": None, "candidate": change["candidate"]} for name, change in DOCUMENT_BOUNDARIES_PATCH.items()}}

ANSWER_CONTINUITY_PATCH = {'step_inputs.py': {'previous': '0baad5ddb854c4188d61a83c29c70e7f988befaf9bbac8a0ac5785273cd74c5a', 'candidate': 'eefc4159dd06c03103fe14329c13a4606c9c430f6f14793a46d6ba915f2ef79d'}, 'document_completion.py': {'previous': '42c21761404d2c9dca0d47974fa3877439bb1397f14f97301b0a8b85a00ea337', 'candidate': '1015513fdbc930385884dd845ed0ea26fa24c90a9ce5f4821e3e80d6b0f2ed34'}, 'clarification_gate.py': {'previous': '8089018aab7111ab41c713415e1d28a497482cafc335c3e226ed3fcc843959b6', 'candidate': '68edc98771dd0a7a253c92d7fc676e3cf608130685c2381602c348b5b5dd2bbe'}, 'document_delivery.py': {'previous': '8de452480bcc1d2c6e0c0064c420ba8cf742827c745b794922c95214ebcc42a9', 'candidate': '4ce6e48167605165dc5e7fced6a07a238690312236b47d98a1d948db7208df85'}}
ANSWER_CONTINUITY_COMPLETE = {**DOCUMENT_BOUNDARIES_COMPLETE, **{name: {"previous": None, "candidate": change["candidate"]} for name, change in ANSWER_CONTINUITY_PATCH.items()}}

DOCUMENT_SIZING_PATCH = {'document_completion.py': {'previous': ANSWER_CONTINUITY_PATCH['document_completion.py']['candidate'], 'candidate': '44baed0c1031a9b951d22ebdd0522d0bf4f7e31df5ad2a68f68411da49570729'}}
DOCUMENT_SIZING_COMPLETE = {**ANSWER_CONTINUITY_COMPLETE, 'document_completion.py': {'previous': None, 'candidate': DOCUMENT_SIZING_PATCH['document_completion.py']['candidate']}}

SOURCE_REVIEW_PATCH = {'document_completion.py': {'previous': '44baed0c1031a9b951d22ebdd0522d0bf4f7e31df5ad2a68f68411da49570729', 'candidate': '2c8cff3922aaed68d9a8243541ae38e1f3eefc951d7f4da43dcc244aacde75a7'}, 'document_delivery.py': {'previous': '4ce6e48167605165dc5e7fced6a07a238690312236b47d98a1d948db7208df85', 'candidate': 'cd63518386ad2ad1db8ff929785fa8a6839ae2aeae37add2058d4f2c14df3d6d'}, 'verification_inputs.py': {'previous': '615057799c0f6b7f019aaffa7923c1a80f0af83bd0e35695885631fa221df65c', 'candidate': '07466b6360831d05f3ec9df6b96bf8216daa954a2066eb44accdbe2cc23e1cd2'}, 'step_inputs.py': {'previous': 'eefc4159dd06c03103fe14329c13a4606c9c430f6f14793a46d6ba915f2ef79d', 'candidate': '2072239d3a93c2684a8e8238b35f8eefef8bdb532be511158acceb9dc8818d22'}}
SOURCE_REVIEW_COMPLETE = {**DOCUMENT_SIZING_COMPLETE, **{name: {'previous': None, 'candidate': change['candidate']} for name, change in SOURCE_REVIEW_PATCH.items()}}

REVIEW_SCOPE_PATCH = {"document_delivery.py":{"previous":"cd63518386ad2ad1db8ff929785fa8a6839ae2aeae37add2058d4f2c14df3d6d","candidate":"ef0fb573426fac4a77158aab2a8cc913e990dc7a6155c51a04e0b2752bbfefcf"},"document_completion.py":{"previous":"2c8cff3922aaed68d9a8243541ae38e1f3eefc951d7f4da43dcc244aacde75a7","candidate":"b8ffe8967d1aa653be26bedf7fe05c5a6137b4813440ae89867c29af0b094f99"}}
REVIEW_SCOPE_COMPLETE = {**SOURCE_REVIEW_COMPLETE, **{name: {"previous": None, "candidate": change["candidate"]} for name, change in REVIEW_SCOPE_PATCH.items()}}

INPUT_PROOF_PATCH = {'document_completion.py': {'previous': 'b8ffe8967d1aa653be26bedf7fe05c5a6137b4813440ae89867c29af0b094f99', 'candidate': 'be13faef410e1c7218ffd5bac997146b47479a7010b4d1194e8b36f16044d973'}, 'document_delivery.py': {'previous': 'ef0fb573426fac4a77158aab2a8cc913e990dc7a6155c51a04e0b2752bbfefcf', 'candidate': '17a7d01c06f9c9dc1e4c9d902ff0d5d61dab2c8ee77f8cdf8d5637d04c250eda'}, 'verification_inputs.py': {'previous': '07466b6360831d05f3ec9df6b96bf8216daa954a2066eb44accdbe2cc23e1cd2', 'candidate': '661ee08bc53dbc44e9c03cb6e80af4810e353f23d1d4fb545a22243d61e852c7'}}
INPUT_PROOF_COMPLETE = {**REVIEW_SCOPE_COMPLETE, **{name: {"previous": None, "candidate": change["candidate"]} for name, change in INPUT_PROOF_PATCH.items()}}

CURRENT_GOAL_PATCH = {'document_delivery.py': {'previous': '17a7d01c06f9c9dc1e4c9d902ff0d5d61dab2c8ee77f8cdf8d5637d04c250eda', 'candidate': '44162f3b5ed72a78cfe8648f3f5c592799c1c0d59b67b238b88f7d8a3b177a51'}, 'usage_evidence.py': {'previous': 'f476adf02e376d1f029bee32a60818623fe75e79b0cee2f1e644f0553b2ac595', 'candidate': '61b0eff9e858074c36597ff3fe8fe792c8980b14bb2c6f3552c956615e678f56'}}
CURRENT_GOAL_COMPLETE = {**INPUT_PROOF_COMPLETE, **{name: {
    'previous': INPUT_PROOF_COMPLETE.get(name, change)['previous'], 'candidate': change['candidate']}
    for name, change in CURRENT_GOAL_PATCH.items()}}

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
    if actual not in [EVALUATED, DOCUMENT_PATCH, CUMULATIVE, STEP_PATCH, STEP_COMPLETE, REVISION_PATCH, REVISION_COMPLETE, MANUSCRIPT_PATCH, COMPLETE, COMPLETION_PATCH, LATEST_COMPLETE, FORMAT_COMPLETION_PATCH, FORMAT_COMPLETION_COMPLETE, LITERAL_COMPLETION_PATCH, LITERAL_COMPLETION_COMPLETE, UPGRADE_GUARD_PATCH, UPGRADE_GUARD_FROM_FORMAT, UPGRADE_GUARD_COMPLETE, REFERENCE_FEEDBACK_PATCH, REFERENCE_FEEDBACK_COMPLETE, FILE_INSPECTION_PATCH, FILE_INSPECTION_COMPLETE, DOCUMENT_PLANNING_PATCH, DOCUMENT_PLANNING_COMPLETE, DOCUMENT_PREFLIGHT_PATCH, DOCUMENT_PREFLIGHT_COMPLETE, SOURCE_TITLE_PATCH, SOURCE_TITLE_COMPLETE, SCOPED_MENU_PATCH, SCOPED_MENU_COMPLETE, DOCUMENT_AGENT_PATCH, DOCUMENT_AGENT_COMPLETE, DOCUMENT_SOURCE_PATCH, DOCUMENT_SOURCE_COMPLETE, DOCUMENT_BOUNDARIES_PATCH, DOCUMENT_BOUNDARIES_COMPLETE, ANSWER_CONTINUITY_PATCH, ANSWER_CONTINUITY_COMPLETE, DOCUMENT_SIZING_PATCH, DOCUMENT_SIZING_COMPLETE, SOURCE_REVIEW_PATCH, SOURCE_REVIEW_COMPLETE, REVIEW_SCOPE_PATCH, REVIEW_SCOPE_COMPLETE, INPUT_PROOF_PATCH, INPUT_PROOF_COMPLETE, CURRENT_GOAL_PATCH, CURRENT_GOAL_COMPLETE]:
        raise RuntimeError('只允许已评估的回复预算适配变更，其他变更需另行迁移。')
    return actual


def private_atomic(path, value):
    temporary = path.with_name(path.name + '.worker-output.tmp')
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


def aof_commands(raw):
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('AOF exceeds bounded maintenance inspection')
    offset = 0
    def line():
        nonlocal offset
        end = raw.index(b'\r\n', offset)
        value = raw[offset:end]
        offset = end + 2
        return value
    while offset < len(raw):
        size = line()
        if not size.startswith(b'*') or not size[1:].isdigit() or not 1 <= int(size[1:]) <= 32:
            raise ValueError('Invalid bounded AOF command')
        command = []
        for _ in range(int(size[1:])):
            length = line()
            if not length.startswith(b'$') or not length[1:].isdigit():
                raise ValueError('Invalid AOF argument')
            count = int(length[1:])
            if count > 2 * 1024 * 1024:
                raise ValueError('AOF argument exceeds inspection bound')
            command.append(raw[offset:offset+count])
            offset += count
            if raw[offset:offset+2] != b'\r\n':
                raise ValueError('Incomplete AOF argument')
            offset += 2
        yield command


def expired_cache_only(before, after, now_ms=None):
    """Prove an append only expires known transient keys at their old deadline.

    No active worker is started during migration; the database and broker
    idle checks still run. Queue writes, unexpired deletion, arbitrary keys,
    changed prefixes and an AOF rewrite remain forbidden.
    """
    import re,time
    if not after.startswith(before):
        return False
    now_ms = int(time.time()*1000) if now_ms is None else now_ms
    deadlines, database = {}, b'0'
    try:
        for args in aof_commands(before):
            name = args[0].upper()
            if name == b'SELECT':
                database = args[1]
            elif name == b'PEXPIREAT' and len(args) == 3:
                deadlines[(database,args[1])] = int(args[2])
            elif name == b'SET' and len(args) >= 3:
                deadlines.pop((database,args[1]),None)
                if len(args) == 5 and args[3].upper() == b'PXAT':
                    deadlines[(database,args[1])] = int(args[4])
            elif name in {b'DEL',b'UNLINK',b'PERSIST'}:
                for key in args[1:]:
                    deadlines.pop((database,key),None)
        deleted = set()
        for args in aof_commands(after[len(before):]):
            name = args[0].upper()
            if name == b'SELECT' and len(args) == 2 and args[1] in {b'0',b'1'}:
                database = args[1]
                continue
            if name not in {b'DEL',b'UNLINK'} or len(args) != 2:
                return False
            key = args[1]
            allowed = (key == b'unacked_mutex'
                       or re.fullmatch(rb'quota:concurrent:[0-9a-f-]{36}',key)
                       or re.fullmatch(rb'rate:[a-zA-Z0-9:._-]{1,128}:[0-9]+',key))
            identity = (database,key)
            if not allowed or identity in deleted or not 0 < deadlines.get(identity,0) <= now_ms:
                return False
            deleted.add(identity)
        return bool(deleted)
    except (ValueError,IndexError):
        return False


def stable_engine_files(before, after, snapshot, root):
    ignored = {'queue.log', 'valkey/dump.rdb'}
    a, b = {f['path']:f for f in before}, {f['path']:f for f in after}
    for path in a.keys() | b.keys():
        if a.get(path) == b.get(path) or path in ignored:
            continue
        if (path.startswith('valkey/appendonlydir/') and path.endswith('.incr.aof')
                and path in a and path in b
                and expired_cache_only((snapshot/'engine'/path).read_bytes(), (root/'engine'/path).read_bytes())):
            continue
        return False
    return True


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
    name = ('current-goal' if patch == CURRENT_GOAL_PATCH else
            'input-proof' if patch == INPUT_PROOF_PATCH else
            'review-scope' if patch == REVIEW_SCOPE_PATCH else
            'source-review' if patch == SOURCE_REVIEW_PATCH else
            'document-sizing' if patch == DOCUMENT_SIZING_PATCH else
            'answer-continuity' if patch == ANSWER_CONTINUITY_PATCH else
            'document-boundaries' if patch == DOCUMENT_BOUNDARIES_PATCH else
            'document-source-instructions' if patch == DOCUMENT_SOURCE_PATCH else
            'document-agent-tools' if patch == DOCUMENT_AGENT_PATCH else
            'scoped-file-menu' if patch == SCOPED_MENU_PATCH else
            'document-source-titles' if patch == SOURCE_TITLE_PATCH else
            'document-length-preflight' if patch == DOCUMENT_PREFLIGHT_PATCH else
            'document-reader-planning' if patch == DOCUMENT_PLANNING_PATCH else
            'document-file-inspection' if patch == FILE_INSPECTION_PATCH else
            'document-reference-feedback' if patch == REFERENCE_FEEDBACK_PATCH else
            'document-upgrade-guard' if 'engine_runtime.py' in patch else
            'document-literal-completion' if patch == LITERAL_COMPLETION_PATCH or patch == LITERAL_COMPLETION_COMPLETE else
            'document-format-completion' if patch == FORMAT_COMPLETION_PATCH or patch == FORMAT_COMPLETION_COMPLETE else
            'document-completion' if 'document_completion.py' in patch else
            'document-verification' if patch == MANUSCRIPT_PATCH else
            'revision-export' if patch == REVISION_PATCH else
            'step-inputs' if 'step_inputs.py' in patch else
            'document-body' if 'document_delivery.py' in patch else 'worker-output')
    original_receipt = root / (name + '-migration.json')
    receipt = root / (name + ('-rollback.json' if args.rollback else '-migration.json'))
    if receipt.exists():
        raise RuntimeError('此修复已有记录，请先核对原结果，不会重复迁移。')
    with startup_lease(root) as lease:
        settled(root, lease)
        saved, infra, data = configuration(root)
        expected = read_private(snapshot / 'original-startup.json')
        if args.rollback:
            # The sole applied mutation is precisely the candidate identity.
            # Every other startup field must still equal the original snapshot.
            expected = {**expected, 'runtimeIdentity': runtime_identity(candidate / 'integrations/agenthub')}
        if saved != expected:
            raise RuntimeError('启动设置与备份不一致，未修改。')
        original = read_private(original_receipt) if args.rollback else None
        expected_files = original.get('afterEngineFiles') if original else files(snapshot / 'engine')
        if files(root / 'engine') != expected_files:
            raise RuntimeError('引擎文件与已验证的迁移回执不一致，未修改。')
        destination = previous if args.rollback else candidate
        verify_runtime(saved, active / 'integrations/agenthub')
        next_saved = {**saved, 'runtimeIdentity': runtime_identity(destination / 'integrations/agenthub')}
        if args.rollback:
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
            record = {'format': 'synplex.worker-output-migration/1', 'status': 'prepared',
                      'previous': str(previous), 'candidate': str(candidate), 'snapshot': str(snapshot),
                      'patch': patch, 'before': saved, 'after': next_saved, 'modelCalls': 0}
            private_atomic(receipt, record)
            private_atomic(root / 'engine-startup.json', next_saved)
            verify_runtime(next_saved, destination / 'integrations/agenthub')
        finally:
            owned.close()
        # Starting/stopping our own idle queue rewrites its log and RDB header.
        # Record those exact post-stop bytes; rollback must reject any later
        # write, rather than comparing to a pre-migration RDB representation.
        after_files = files(root / 'engine')
        if not stable_engine_files(expected_files, after_files, snapshot, root):
            raise RuntimeError('迁移后出现非预期引擎文件变化，保留prepared回执以供核对。')
        private_atomic(receipt, {**record, 'status': 'applied', 'afterEngineFiles': after_files})
    print('执行回复预算修复已离线迁移；原启动设置和数据库备份保留，没有执行任务或调用模型。')


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
