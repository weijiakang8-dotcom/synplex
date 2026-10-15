"""One offline compatibility scenario; no database, network or model is started."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from source_identity import source_identity, verify_source, runtime_identity, verify_runtime
import engine_runtime as runtime
import engine_recovery as recovery
from private_infrastructure import write_private

root = Path(sys.argv[2])
backend = root / "backend"
for name in ["app", "alembic/versions"]:
    (backend / name).mkdir(parents=True)
for name in ["app/main.py", "alembic/versions/0001.py", "requirements.lock", "requirements.txt", "alembic.ini"]:
    (backend / name).write_text("# original source\n")
identity = source_identity(backend)
saved = {"format": "synplex.engine-startup/1", "backend": str(backend), "sourceIdentity": identity,
         "runtimeIdentity": runtime_identity(),
         "lockSha256": "fixture-lock", "apiPort": 5214, "redisPort": 5216, "databasePort": 5218,
         "infrastructureId": "fixture", "providerConfigured": False}
runtime.verify_environment = recovery.verify_environment = lambda backend: "fixture-lock"


def rejected(action, message):
    try:
        action()
    except RuntimeError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("Incompatible source was accepted")


engine = root / "engine"
(engine / "infrastructure").mkdir(parents=True)
(engine / "engine").mkdir()
write_private(engine / "engine-startup.json", saved)
write_private(engine / "infrastructure/infrastructure.json", {"port": 5218, "id": "fixture", "pgdata": str(engine / "infrastructure/postgres")})
write_private(engine / "engine/bootstrap.json", {"api_port": 5214, "redis_port": 5216, "backend": str(backend), "infrastructure_id": "fixture", "model_mode": "disabled", "database_ready": True, "runtime_format": "synplex.engine-runtime/2"})
assert runtime.configuration(engine)[0] == saved
snapshot = root / "snapshot"
snapshot.mkdir()
write_private(snapshot / "original-startup.json", saved)
write_private(snapshot / "engine-snapshot.json", {"format": "synplex.engine-snapshot/1", "files": recovery.files(snapshot)})
original_files = recovery.files(engine)
restored = root / "must-not-be-created"
options = dict(backend=backend, pg_bin=root / "not-invoked", valkey=root / "not-invoked", api_port=5214, redis_port=5216, database_port=5218)

# Match by bytes, not by absolute path. Non-executable test/log files do not
# invalidate the runtime; adding, deleting or changing shipped code does.
copied = root / "copied"
shutil.copytree(backend, copied)
assert verify_source(copied, saved) == identity
(backend / "test.log").write_text("not runtime source")
assert verify_source(backend, saved) == identity
for change in ["edit", "add", "delete", "migration"]:
    file = backend / ({"add": "app/new.py", "migration": "alembic/versions/0001.py"}.get(change, "app/main.py"))
    prior = file.read_bytes() if file.exists() else None
    if change == "delete":
        file.unlink()
    else:
        file.write_text("# changed executable\n")
    rejected(lambda: runtime.configuration(engine), "源码")
    if change == "edit":
        cli = subprocess.run([sys.executable, "-B", str(Path(sys.argv[1]) / "engine_runtime.py"), "check", "--root", str(engine)], capture_output=True, text=True, timeout=5)
        assert cli.returncode == 1 and "请使用原版本安装包" in cli.stderr, cli.stderr
        assert str(backend) not in cli.stderr and "Traceback" not in cli.stderr
    rejected(lambda: recovery.restore(snapshot, restored, **options), "源码")
    assert not restored.exists()
    assert recovery.files(engine) == original_files
    if prior is None:
        file.unlink()
    else:
        file.write_bytes(prior)
    assert runtime.configuration(engine)[0] == saved

linked = backend / "app/alias.py"
linked.symlink_to(backend / "app/main.py")
rejected(lambda: source_identity(backend), "替身")
linked.unlink()
legacy = {key: value for key, value in saved.items() if key != "sourceIdentity"}
write_private(engine / "engine-startup.json", legacy)
rejected(lambda: runtime.configuration(engine), "缺少执行源码指纹")
assert json.loads((engine / "engine-startup.json").read_text()) == legacy
rejected(lambda: verify_source(copied, legacy), "缺少执行源码指纹")
write_private(engine / "engine-startup.json", saved)
assert recovery.files(engine) == original_files
assert recovery.verify_snapshot(snapshot)["format"] == "synplex.engine-snapshot/1"

# An unchanged vendor backend/lock does not authorize a different wrapper.
# Work only on our own copy; no installed source or active engine is touched.
wrappers = root / "runtime-copy"
shutil.copytree(Path(sys.argv[1]), wrappers, ignore=shutil.ignore_patterns("__pycache__"))
assert runtime_identity(wrappers) == saved["runtimeIdentity"]
runtime.verify_runtime = recovery.verify_runtime = lambda value: verify_runtime(value, wrappers)
for change in ["edit", "add", "delete", "bridge"]:
    file = wrappers / ({"add": "new_runtime.py", "bridge": "read_document.mjs"}.get(change, "task_tools.py"))
    prior = file.read_bytes() if file.exists() else None
    if change == "delete":
        file.unlink()
    else:
        file.write_text("# altered adapter\n" if file.suffix == ".py" else "// altered bridge\n")
    rejected(lambda: runtime.configuration(engine), "执行适配程序")
    rejected(lambda: recovery.restore(snapshot, restored, **options), "执行适配程序")
    from local_runner import load_config
    rejected(lambda: load_config(engine / "engine", backend), "执行适配程序")
    assert not restored.exists() and recovery.files(engine) == original_files
    if change == "edit":
        cli = subprocess.run([sys.executable, "-B", str(wrappers / "engine_runtime.py"), "check", "--root", str(engine)], capture_output=True, text=True, timeout=5)
        assert cli.returncode == 1 and "请使用原版本安装包" in cli.stderr, cli.stderr
        assert "Traceback" not in cli.stderr and str(backend) not in cli.stderr
    if prior is None:
        file.unlink()
    else:
        file.write_bytes(prior)
    assert runtime.configuration(engine)[0] == saved
link = wrappers / "alias.py"
link.symlink_to(wrappers / "task_tools.py")
rejected(lambda: runtime_identity(wrappers), "替身")
link.unlink()
legacy_runtime = {key: value for key, value in saved.items() if key != "runtimeIdentity"}
write_private(engine / "engine-startup.json", legacy_runtime)
rejected(lambda: runtime.configuration(engine), "缺少执行适配程序指纹")
assert json.loads((engine / "engine-startup.json").read_text()) == legacy_runtime
write_private(engine / "engine-startup.json", saved)
assert recovery.files(engine) == original_files
print("Exact relocated backend and wrapper accepted; changed/legacy/symlink programs refused before API, worker or restore writes; modelCalls=0")
