"""Exercise the migration's trust boundary with no engine or network."""
import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('document_patch', ROOT / 'scripts/runtime/patch-document-reader.py')
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)
with tempfile.TemporaryDirectory(prefix='synplex-reader-patch-') as folder:
    prior, candidate = Path(folder) / 'before', Path(folder) / 'after'
    prior.mkdir()
    candidate.mkdir()
    current = (ROOT / 'integrations/agenthub/task_tools.py').read_text()
    old = current.replace(patch.NEW_LOOP, patch.OLD_LOOP).replace(patch.NEW_BIND, patch.OLD_BIND)
    assert old != current
    (prior / 'task_tools.py').write_text(old)
    (candidate / 'task_tools.py').write_text(current)
    for directory in [prior, candidate]:
        (directory / 'unchanged.py').write_text('# protected adapter\n')
    # This historical migration targets the reader/queue guard revision. Undo
    # only the later evaluated multicall-binary path fix in this fixture;
    # its exact historical hash remains mandatory and is never updated here.
    runtime = (ROOT / 'integrations/agenthub/engine_runtime.py').read_bytes().replace(
        b'str(valkey.absolute())', b'str(valkey.resolve())')
    assert hashlib.sha256(runtime).hexdigest() == patch.RUNTIME_AFTER
    (prior / 'engine_runtime.py').write_bytes(b'# synthetic previous runtime\n')
    (candidate / 'engine_runtime.py').write_bytes(runtime)
    patch.RUNTIME_BEFORE = hashlib.sha256((prior / 'engine_runtime.py').read_bytes()).hexdigest()
    evaluated = patch.evaluated_patch(prior, candidate)
    assert evaluated['task_tools.py']['previous'] != evaluated['task_tools.py']['candidate']
    def rejected():
        try:
            patch.evaluated_patch(prior, candidate)
        except RuntimeError:
            return
        raise AssertionError('Unreviewed adapter accepted')
    for name, value in [('unchanged.py', '# other change'), ('new.py', '# extra code'), ('engine_runtime.py', '# unreviewed runtime'), ('task_tools.py', current + '\n# unexpected change')]:
        file = candidate / name
        previous = file.read_bytes() if file.exists() else None
        file.write_text(value)
        rejected()
        if previous is None:
            file.unlink()
        else:
            file.write_bytes(previous)
    (candidate / 'alias.py').symlink_to(candidate / 'task_tools.py')
    rejected()
    (candidate / 'alias.py').unlink()
    record = Path(folder) / 'receipt.json'
    patch.private_atomic(record, {'status': 'prepared'})
    patch.private_atomic(record, {'status': 'applied'})
    assert json.loads(record.read_text()) == {'status': 'applied'} and record.stat().st_mode & 0o077 == 0
print('Only exact document-reader delta accepted; unrelated edits, additions and symlinks refused; private atomic receipt verified; modelCalls=0')
