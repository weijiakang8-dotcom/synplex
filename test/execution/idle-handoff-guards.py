"""One boundary scenario, using the Node test's synthetic private fixture."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
from engine_runtime import ensure_execution_allowed
from handoff_state import durable_json, proof_for_target, RETIRED

target = Path(sys.argv[2])
proof = json.loads((target / "handoff-complete.json").read_text())
engine = target / "engine"
ensure_execution_allowed(engine)
try:
    ensure_execution_allowed(Path(proof["source"]["engine"]))
except RuntimeError as error:
    assert "原实例已停止使用" in str(error)
else:
    raise AssertionError("Retired original admitted")
file = Path(proof["source"]["engine"]) / RETIRED
before = file.read_bytes()
durable_json(file, proof, once=True)
assert file.read_bytes() == before
try:
    durable_json(file, {**proof, "id": "different-transfer"}, once=True)
except RuntimeError:
    pass
else:
    raise AssertionError("Earlier retirement overwritten")
assert file.read_bytes() == before
# An enabled flag alone is never evidence of a completed joint handoff.
complete = target / "handoff-complete.json"
exact = complete.read_bytes()
complete.unlink()
try:
    ensure_execution_allowed(engine)
except (RuntimeError, FileNotFoundError):
    pass
else:
    raise AssertionError("Interrupted handoff admitted")
complete.write_bytes(exact)
os.chmod(complete, 0o600)
ensure_execution_allowed(engine)
print("Persistent original retirement, same-intent idempotency and unfinished handoff refusal passed; modelCalls=0")
