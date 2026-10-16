"""Exercise exact adapter migration and private atomic-write boundaries offline."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('worker_patch', root / 'scripts/runtime/patch-worker-output.py')
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)
with tempfile.TemporaryDirectory(prefix='synplex-worker-patch-') as folder:
    before, after = Path(folder) / 'before', Path(folder) / 'after'
    before.mkdir()
    after.mkdir()
    current = (root / 'integrations/agenthub/local_runner.py').read_text()
    previous = current.replace('    from worker_output import install as install_worker_output\n    install_worker_output()\n', '')
    assert hashlib.sha256(previous.encode()).hexdigest() == patch.EVALUATED['local_runner.py']['previous']
    (before / 'local_runner.py').write_text(previous)
    # Reconstruct the evaluated predecessor by removing only this exact guard.
    current_engine = (root / 'integrations/agenthub/engine_runtime.py').read_text()
    start = current_engine.index('def ensure_migrations_complete(root):')
    end = current_engine.index('def configuration(root):', start)
    previous_engine = (current_engine[:start]+current_engine[end:]).replace('    ensure_migrations_complete(root)\n','')
    assert hashlib.sha256(previous_engine.encode()).hexdigest() == patch.UPGRADE_GUARD_PATCH['engine_runtime.py']['previous']
    (before / 'engine_runtime.py').write_text(previous_engine)
    old_usage = (root / 'integrations/agenthub/usage_evidence.py').read_text()
    old_usage = old_usage[:old_usage.index('\n\nasync def verification_projection')] + old_usage[old_usage.index('\n\ndef install_api'):]
    old_usage = old_usage.replace(',\n        \"verification\": await verification_projection(session, execution)', '')
    assert hashlib.sha256(old_usage.encode()).hexdigest() == patch.CURRENT_GOAL_PATCH['usage_evidence.py']['previous']
    (before / 'usage_evidence.py').write_text(old_usage)
    for name in ['local_runner.py', 'worker_output.py', 'document_delivery.py', 'document_completion.py', 'step_inputs.py', 'engine_runtime.py', 'clarification_gate.py', 'verification_inputs.py', 'usage_evidence.py']:
        (after / name).write_bytes((root / 'integrations/agenthub' / name).read_bytes())
    for directory in [before, after]:
        (directory / 'unchanged.py').write_text('# preserved source\n')
    assert patch.evaluated_patch(before, after) == patch.CURRENT_GOAL_COMPLETE
    def rejected():
        try:
            patch.evaluated_patch(before, after)
        except RuntimeError:
            return
        raise AssertionError('Unevaluated runtime migration accepted')
    for name in ['unchanged.py', 'worker_output.py', 'document_delivery.py', 'document_completion.py', 'step_inputs.py', 'engine_runtime.py', 'clarification_gate.py', 'verification_inputs.py', 'usage_evidence.py', 'new.py']:
        file = after / name
        saved = file.read_bytes() if file.exists() else None
        file.write_text('# unevaluated mutation\n')
        rejected()
        if saved is None:
            file.unlink()
        else:
            file.write_bytes(saved)
    (after / 'alias.py').symlink_to(after / 'worker_output.py')
    rejected()
    (after / 'alias.py').unlink()
    receipt = Path(folder) / 'receipt.json'
    patch.private_atomic(receipt, {'status': 'prepared'})
    patch.private_atomic(receipt, {'status': 'applied'})
    assert json.loads(receipt.read_text()) == {'status': 'applied'}
    assert receipt.stat().st_mode & 0o077 == 0
    target = Path(folder) / 'protected'
    target.write_text('preserve')
    receipt.with_name(receipt.name + '.worker-output.tmp').symlink_to(target)
    try:
        patch.private_atomic(receipt, {'status': 'unexpected'})
    except OSError:
        pass
    else:
        raise AssertionError('Atomic receipt followed a symlink')
    assert target.read_text() == 'preserve' and json.loads(receipt.read_text()) == {'status': 'applied'}
print('Exact evaluated worker delta accepted; unrelated edits, additions, symlinks and receipt alias refused; modelCalls=0')

# Real expiration records are accepted only at their recorded deadline. Broker
# messages, arbitrary deletions and unexpired quota state must remain protected.
def resp(*parts):
    parts = [p if isinstance(p,bytes) else str(p).encode() for p in parts]
    return b'*'+str(len(parts)).encode()+b'\r\n'+b''.join(b'$'+str(len(p)).encode()+b'\r\n'+p+b'\r\n' for p in parts)
key = 'quota:concurrent:11111111-1111-4111-8111-111111111111'
base = resp('SELECT',0)+resp('INCRBY',key,1)+resp('PEXPIREAT',key,1000)
expiry = resp('SELECT',0)+resp('UNLINK',key)
assert patch.expired_cache_only(base,base+expiry,now_ms=1000)
assert not patch.expired_cache_only(base,base+expiry,now_ms=999)
assert not patch.expired_cache_only(base,base+resp('LPUSH','synplex-isolated','work'),now_ms=2000)
assert not patch.expired_cache_only(base,base+resp('DEL','arbitrary'),now_ms=2000)
assert not patch.expired_cache_only(base,base+resp('UNLINK',key)+resp('UNLINK',key),now_ms=2000)
assert not patch.expired_cache_only(base,expiry,now_ms=2000)
assert not patch.expired_cache_only(base+resp('PERSIST',key),base+resp('PERSIST',key)+expiry,now_ms=2000)
rate = b'rate:ip:127.0.0.1:123'
rate_base = resp('SELECT',0)+resp('INCRBY',rate,1)+resp('PEXPIREAT',rate,1000)
assert patch.expired_cache_only(rate_base,rate_base+resp('UNLINK',rate),now_ms=1000)
assert not patch.expired_cache_only(rate_base,rate_base+resp('UNLINK',rate),now_ms=999)
import sys
sys.path.insert(0,str(root/'integrations/agenthub'))
from engine_runtime import ensure_migrations_complete
with tempfile.TemporaryDirectory(prefix='synplex-migration-guard-') as folder:
    receipt = Path(folder)/'document-upgrade-guard-migration.json'
    for status in ['prepared','unknown','failed']:
        patch.private_atomic(receipt,{'format':'synplex.worker-output-migration/1','status':status})
        try: ensure_migrations_complete(Path(folder))
        except RuntimeError: pass
        else: raise AssertionError('Incomplete upgrade allowed startup')
    patch.private_atomic(receipt,{'format':'synplex.worker-output-migration/1','status':'applied'})
    ensure_migrations_complete(Path(folder))
print('Recorded cache expiry accepted; active/unexpired/rewritten state refused; unfinished migration blocks startup; modelCalls=0')
