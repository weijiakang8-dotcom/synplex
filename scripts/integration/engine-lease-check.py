"""One free local lifecycle regression. Standard library; no engine/model starts."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations/agenthub"))
import engine_runtime as runtime


def probe(root, shared=False):
    code = """import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from engine_runtime import startup_lease
try:
 with startup_lease(Path(sys.argv[2]),shared=sys.argv[3]=='shared'):pass
except RuntimeError:sys.exit(17)
"""
    return subprocess.run([sys.executable, '-B', '-c', code, str(ROOT / 'integrations/agenthub'),
                           str(root), 'shared' if shared else 'exclusive'],
                          capture_output=True, timeout=10).returncode


def run():
    with tempfile.TemporaryDirectory(prefix='synplex-engine-lease-') as folder:
        root = Path(folder)
        with runtime.startup_lease(root, shared=True):
            assert probe(root, shared=True) == 0
            assert probe(root) == 17
        with runtime.startup_lease(root):
            assert probe(root, shared=True) == 17
        assert probe(root) == 0
        # The supervisor disappears without normal cleanup. Its child retains
        # the same exclusive file description until the child itself is done.
        child_code = """import sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from engine_runtime import startup_lease
root=Path(sys.argv[2])
with startup_lease(root,inherited_fd=int(sys.argv[3]),shared=True):
 print('child-holds-lease',flush=True)
 deadline=time.monotonic()+15
 while not (root/'child-stop').exists() and time.monotonic()<deadline:time.sleep(.02)
print('child-released',flush=True)
"""
        parent_code = """import os,subprocess,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from engine_runtime import startup_lease
with startup_lease(Path(sys.argv[2])) as lease:
 subprocess.Popen([sys.executable,'-B','-c',sys.argv[3],sys.argv[1],sys.argv[2],str(lease.fileno())],pass_fds=(lease.fileno(),))
 os._exit(0)
"""
        parent = subprocess.Popen([sys.executable, '-B', '-c', parent_code,
            str(ROOT / 'integrations/agenthub'), str(root), child_code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            assert parent.stdout.readline().strip() == 'child-holds-lease'
            assert parent.wait(timeout=5) == 0
            assert probe(root) == 17 and probe(root, shared=True) == 17
        finally:
            (root / 'child-stop').touch()
            output, error = parent.communicate(timeout=20)
        assert 'child-released' in output and not error
        assert probe(root) == 0
        # An unrelated passed descriptor cannot authorize a different lock.
        with open(root / 'unrelated', 'w+') as other:
            try:
                with runtime.startup_lease(root, inherited_fd=os.dup(other.fileno())):
                    raise AssertionError('Unrelated descriptor admitted')
            except RuntimeError:
                pass
        (root / 'startup.lock').unlink()
        (root / 'startup.lock').symlink_to(root / 'unrelated')
        try:
            with runtime.startup_lease(root):
                raise AssertionError('Symlink accepted')
        except OSError:
            pass
        (root / 'startup.lock').unlink()
        # A changed recovery flag must be checked AFTER taking the lock, before
        # constructing infrastructure. No real database or queue is used here.
        configuration = runtime.configuration
        try:
            def checked_configuration(path):
                assert probe(path, shared=True) == 17
                (path / 'recovery.json').write_text('{"executorsEnabled":false}')
                os.chmod(path / 'recovery.json', 0o600)
                return {}, {}, {}
            runtime.configuration = checked_configuration
            try:
                runtime.supervise(root)
            except RuntimeError as error:
                assert '停用' in str(error)
            else:
                raise AssertionError('Recovery state bypassed')
        finally:
            runtime.configuration = configuration
        assert probe(root) == 0
        # The executable entry cannot use shared mode or skip the preflight.
        import contextlib
        import local_runner
        original = (local_runner.private_read, local_runner.run_service, runtime.startup_lease, sys.argv)
        admissions = []
        @contextlib.contextmanager
        def entry_lease(path, **kwargs):
            assert kwargs.get('shared', False) is False
            yield
        try:
            local_runner.private_read = lambda path: {'runtime_format':'synplex.engine-runtime/2'}
            local_runner.run_service = lambda command, state, backend, **kwargs: admissions.append((command, kwargs['supervised']))
            runtime.startup_lease = entry_lease
            for command in ['api', 'worker']:
                sys.argv = ['runner', '--state', str(root / 'engine'), '--backend', str(root), command]
                local_runner.main()
            assert admissions == [('api', False), ('worker', False)]
        finally:
            local_runner.private_read, local_runner.run_service, runtime.startup_lease, sys.argv = original
        original = (local_runner.load_config, local_runner.api, runtime.ensure_database_idle, runtime.ensure_queue_idle)
        guards = []
        try:
            local_runner.load_config = lambda *args: {'runtime_format':'synplex.engine-runtime/2'}
            local_runner.api = lambda *args: (_ for _ in ()).throw(AssertionError('API started'))
            runtime.ensure_queue_idle = lambda *args: (_ for _ in ()).throw(AssertionError('Queue reached before DB refusal'))
            def pending(data):
                guards.append('database refused')
                raise RuntimeError('original pending')
            runtime.ensure_database_idle = pending
            for command in ['api', 'worker']:
                try:local_runner.run_service(command, root, root)
                except RuntimeError as error:assert str(error) == 'original pending'
                else:raise AssertionError('Direct service bypassed original work')
            assert len(guards) == 2
        finally:
            local_runner.load_config, local_runner.api, runtime.ensure_database_idle, runtime.ensure_queue_idle = original
    return {'lifetimeLease': 'passed', 'standaloneServicesExcludeMaintenance': True,
            'supervisedChildKeepsLeaseAfterParentExit': True, 'configurationCheckedUnderLease': True,
            'unrelatedDescriptorAndSymlinkRefused': True, 'directEntrypointsRequireExclusiveAndPreflight': True, 'modelCalls': 0,
            'limitation': 'Local lifecycle only; not cross-directory execution handoff'}


if __name__ == '__main__':
    print(json.dumps(run()))
