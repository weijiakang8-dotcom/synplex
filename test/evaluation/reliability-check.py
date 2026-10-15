"""One merged calculator/CLI check using independent fixed-source arithmetic."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

root, directory = Path(sys.argv[1]), Path(sys.argv[2])
script = root / "scripts/evaluation/reliability.py"
spec = importlib.util.spec_from_file_location("reliability", script)
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)
fixture = json.loads((root / "test/evaluation/reliability-oracle.json").read_text())
benchmark = metrics.benchmark_metrics(fixture["scenarios"])
for actual, expected in zip(benchmark["scenarios"], fixture["expected"]):
    assert {key: actual[key] for key in expected} == expected
for key, expected in fixture["summary"].items():
    assert benchmark["summary"][key] == expected
assert benchmark["summary"]["crs"] != benchmark["summary"]["meanScenarioCrs"]
assert benchmark["summary"]["byType"]["MC"]["count"] + benchmark["summary"]["byType"]["EC"]["count"] == benchmark["summary"]["rounds"]

missing = {"id": "missing", "order": [{"id": "first", "type": "EC"}, {"id": "second", "type": "MC"}], "observations": [{"id": "first", "score": 1}]}
result = metrics.benchmark_metrics([missing])
assert result["summary"]["rounds"] == 2 and result["summary"]["measuredRounds"] == 1
assert result["summary"]["tcr"] is None and result["scenarios"][0]["missingRounds"] == ["second"]

fingerprint = "a" * 64
runs = [{"id": f"run-{index}", "conditionsHash": fingerprint, "independent": True, "passed": index < 8} for index in range(10)]
repeat = metrics.repeat_metrics([{"id": "repeat", "runs": runs}])
assert repeat["passPowerK"] == .4667 and repeat["passAtK"] == 1
assert metrics.repeat_metrics([{"id": "small", "runs": runs[:2]}])["passPowerK"] is None
assert metrics.repeat_metrics([{"id": "mixed", "runs": [*runs[:2], {**runs[2], "conditionsHash": "b"*64}]}])["passPowerK"] is None
assert metrics.repeat_metrics([{"id": "missing", "runs": [*runs[:2], {**runs[2], "passed": None}]}])["passPowerK"] is None
assert metrics.repeat_metrics([{"id": "assisted", "runs": [*runs[:2], {**runs[2], "independent": False}]}])["tasks"][0]["excludedNonIndependentRuns"] == 1
try:
    metrics.repeat_metrics([{"id": "one", "runs": runs}, {"id": "two", "runs": runs}])
except ValueError:
    pass
else:
    raise AssertionError("One run counted in multiple tasks")

faults = [{"id": str(index), "category": "network", "outcome": outcome, "duplicateSideEffect": False, "recoveryMs": index*100} for index, outcome in enumerate(["automatic", "assisted", "blocked", "unknown", "unrecovered"])]
recovery = metrics.recovery_metrics(faults)
assert recovery["rates"]["automatic"] == .2 and recovery["rates"]["assisted"] == .2 and recovery["rates"]["blocked"] == .2
assert recovery["duplicateRate"] == 0 and recovery["recoveryTime"]["p95Ms"] is None
assert metrics.recovery_metrics([{**faults[0], "duplicateSideEffect": None}])["duplicateRate"] is None
assert metrics.recovery_metrics([])["rates"]["automatic"] is None

empty = {"format": "synplex.reliability-input/1", "provenance": "product_evidence", "scenarios": [], "repeatTasks": [], "faults": []}
result = metrics.calculate(empty)
assert result["benchmark"]["summary"]["tcr"] is None and result["repeats"]["passPowerK"] is None
assert result["officialBenchmark"] is False

data = {**empty, "provenance": "fixture", "scenarios": fixture["scenarios"], "repeatTasks": [{"id": "repeat", "runs": runs}], "faults": faults}
source, output = directory / "input.json", directory / "output.json"
source.write_text(json.dumps(data))
command = [sys.executable, "-I", "-B", str(script), str(source), str(output)]
done = subprocess.run(command, capture_output=True, text=True, timeout=5)
assert done.returncode == 0, done.stderr
before = output.read_bytes()
assert output.stat().st_mode & 0o077 == 0
assert json.loads(before)["provenance"] == "fixture"
refused = subprocess.run(command, capture_output=True, text=True, timeout=5)
assert refused.returncode == 1 and output.read_bytes() == before
data["scenarios"][0]["observations"].append(data["scenarios"][0]["observations"][0])
source.write_text(json.dumps(data))
invalid_output = directory / "invalid.json"
refused = subprocess.run([*command[:-1], str(invalid_output)], capture_output=True, text=True, timeout=5)
assert refused.returncode == 1 and not invalid_output.exists()
print("Fixed-source arithmetic, missing/duplicate/mixed-run protection, recovery denominators and real CLI: passed; modelCalls=0")
