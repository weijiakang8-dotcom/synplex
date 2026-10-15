"""Free CI boundary regression; query rows are explicit fixtures, not a real DB."""
import sys
import importlib.util
from pathlib import Path
import tempfile

sys.path.insert(0, sys.argv[1])
from engine_reconcile import inspect_tasks

data = {"workflow_id": "original-workflow", "organization_id": "original-org", "user_id": "original-user"}
good = ("pending", data["workflow_id"], data["organization_id"], data["user_id"], data["organization_id"], data["user_id"])
rows = {"original": good, "missing": None}
for index in range(1, 6):
    wrong = list(good)
    wrong[index] = "another-identity"
    rows[str(index)] = tuple(wrong)


class Fixture:
    def __init__(self):
        self.calls = []
        self.row = None

    def execute(self, query, args):
        assert query.startswith("SELECT ")
        self.calls.append(args[0])
        self.row = rows[args[0]]
        return self

    def fetchone(self):
        return self.row


bindings = [{"taskId": key, "state": "ready_to_inspect"} for key in rows]
bindings += [{"taskId": "must-not-query", "state": "unidentified_submission"}]
original = [dict(row) for row in bindings]
connection = Fixture()
result = inspect_tasks(connection, data, bindings)
assert result[0] == {"taskId": "original", "state": "original_task_verified", "engineStatus": "pending"}
assert result[1]["state"] == "task_missing"
assert all(row["state"] == "task_identity_mismatch" for row in result[2:7])
assert result[-1]["state"] == "unidentified_submission"
assert "must-not-query" not in connection.calls
assert bindings == original
legacy = Fixture()
assert inspect_tasks(legacy, data, [{'taskId':None,'state':'ready_to_find_original'}]) == [
    {'taskId':None,'state':'unidentified_submission'}]
assert not legacy.calls, 'A snapshot without the receipt table must stay unknown'
duplicates = inspect_tasks(Fixture(), data, [
    {'taskId':'original','state':'ready_to_inspect'}, {'taskId':'original','state':'ready_to_inspect'}])
assert all(row['state']=='duplicate_remote_identity' for row in duplicates)
helper = Path(sys.argv[1]).resolve().parents[1] / "scripts/runtime/recovery-origin.py"
spec = importlib.util.spec_from_file_location("recovery_origin", helper)
origin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(origin)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    snapshot, engine, workspace = [root / name for name in ["snapshot", "engine", "workspace"]]
    for folder in [snapshot, workspace, engine / "engine", engine / "infrastructure/postgres"]:
        folder.mkdir(parents=True)
    manifest = {"workspace": str(workspace), "engine": str(engine)}
    assert origin.origin_paths(snapshot, manifest) == (workspace, engine)
    alias = root / "alias"
    alias.symlink_to(workspace)
    for invalid in [{**manifest, "workspace": str(alias)}, {**manifest, "engine": str(workspace)},
                    {**manifest, "workspace": str(snapshot)}, {**manifest, "workspace": str(root / "missing")}]:
        try:
            origin.origin_paths(snapshot, invalid)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Unknown, overlapping or aliased original accepted")
print("Workflow, execution org/user and workflow org/creator checked; pending not completed; modelCalls=0")
