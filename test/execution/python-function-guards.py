"""Free compiler/JSON contracts; only fixed trusted arithmetic is executed here."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "integrations/agenthub"))
from python_guards import prepare_source, RUNTIME, BUILTINS
from python_cases import json_value, load_cases

valid = "def total(values):\n    count=0\n    for value in values:\n        if value > 0:\n            count += value\n    return count\n"
runtime = {}
exec(RUNTIME, runtime)
namespace = {"__builtins__": runtime["SAFE_BUILTINS"], "__synplex_value": runtime["safe_value"],
             "__synplex_binary": runtime["safe_binary"]}
exec(compile(prepare_source(valid), "<trusted-contract-fixture>", "exec"), namespace)
assert namespace["total"]([2, -5, 7]) == 9
for source in ["import os\ndef f(): return 1", "def f(): return (1).__class__", "def f(): return __builtins__",
               "def f(): return eval('1')", "def f():\n    while True: pass", "@len\ndef f(): return 1",
               "def f(): return [x for x in range(1000)]", "def f(): return 2**999999",
               "def f(a=1): return a", "def f():\n    try: return 1\n    except: return 2",
               "def f():\n    def nested(): return 1\n    return nested()"]:
    try:
        prepare_source(source)
    except ValueError:
        pass
    else:
        raise AssertionError("Unsafe/unsupported source accepted")
for value in [lambda: runtime["safe_binary"]("mul", "x", 10**12),
              lambda: runtime["safe_binary"]("mod", "%1000000000s", "x"),
              lambda: runtime["bounded_range"](10**6),
              lambda: runtime["safe_value"](["x"*10000]*10)]:
    try:
        value()
    except ValueError:
        pass
    else:
        raise AssertionError("Allocation bound bypassed")
assert set(runtime["SAFE_BUILTINS"]) == BUILTINS
assert json_value(True) != json_value(1) and json_value(1) != json_value(1.0)
spec = {"function": "total", "cases": [{"label": "原始预期", "args": [[2,3]], "kwargs": {}, "expected": 5}]}
assert load_cases(json.dumps(spec).encode())["cases"][0]["expected"] == 5
try:
    load_cases(b'{"function":"total","function":"changed","cases":[]}')
except ValueError:
    pass
else:
    raise AssertionError("Duplicate JSON fields must not select a different function")
for invalid in [{**spec, "function": "module.total"}, {**spec, "command": "anything"},
                {**spec, "cases": []}, {**spec, "cases": spec["cases"]*7},
                {**spec, "cases": [{**spec["cases"][0], "expected": float('nan')}]}]:
    try:
        load_cases(json.dumps(invalid).encode())
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid test specification accepted")
print("受限函数语法、分配边界和JSON预期契约通过；没有运行上传代码或模型。")
