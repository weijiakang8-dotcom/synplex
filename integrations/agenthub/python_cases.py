"""Bounded, file-backed Python function checks on Mac; expected values stay outside.

This is not a project shell, dependency installer or general test runner. A fresh
OS sandbox evaluates each supplied JSON case. No caller paths or commands.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import sysconfig
import tempfile
from python_guards import prepare_source, RUNTIME

MAX_SOURCE = 128 * 1024
MAX_CASES = 6
MAX_TESTS = 32 * 1024
MAX_OUTPUT = 64 * 1024

WORKER = r'''
import contextlib,json,os,resource,sys
for limit,value in [(resource.RLIMIT_CPU,1),
                    (resource.RLIMIT_FSIZE,65536),(resource.RLIMIT_NOFILE,32),
                    (resource.RLIMIT_NPROC,0),(resource.RLIMIT_CORE,0)]:
    resource.setrlimit(limit,(value,value))
payload=json.loads(sys.stdin.buffer.read(180000))
encode=json.dumps
output=sys.stdout
namespace={'__name__':'uploaded_function','__builtins__':SAFE_BUILTINS,
           '__synplex_value':safe_value,'__synplex_binary':safe_binary}
steps=0
depth=0
def trace(frame,event,arg):
    global steps,depth
    if frame.f_code.co_filename=='<uploaded-source>':
        steps+=1
        if event=='call': depth+=1
        elif event=='return': depth-=1
        if steps>5000 or depth>20: raise RuntimeError('step limit')
    return trace
try:
    safe_value(payload['args']);safe_value(payload['kwargs'])
    with open('/dev/null','w') as quiet,contextlib.redirect_stdout(quiet),contextlib.redirect_stderr(quiet):
        exec(compile(payload['source'],'<uploaded-source>','exec'),namespace)
        target=namespace.get(payload['function'])
        if not callable(target):
            raise TypeError('missing callable')
        sys.settrace(trace)
        try:
            actual=safe_value(target(*payload['args'],**payload['kwargs']))
        finally:
            sys.settrace(None)
        serialized=encode({'ok':True,'actual':actual},ensure_ascii=False,allow_nan=False,sort_keys=True,separators=(',',':'))
    if len(serialized.encode('utf-8'))>60000:
        raise ValueError('result too large')
except BaseException:
    serialized='{"ok":false}'
output.write(serialized)
output.flush()
'''


def available():
    return sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").is_file()


def sandbox_profile(output, error):
    # Deny by default, unlike the broader development-shell profile. No fork,
    # network, Mach service, signal to another process or private directory read.
    executable = str(Path(sys.executable).resolve())
    roots = {str(Path(sys.base_prefix).resolve()), str(Path(sysconfig.get_paths()["stdlib"]).resolve()),
             "/System/Library", "/System/Volumes/Preboot/Cryptexes/OS", "/usr/lib"}
    reads = " ".join("(subpath " + json.dumps(p) + ")" for p in sorted(roots))
    writes = " ".join("(literal " + json.dumps(str(p.resolve())) + ")" for p in (output, error))
    return ("(version 1) (deny default) "
            "(allow process-exec (literal " + json.dumps(executable) + ")) "
            "(allow file-read-metadata (vnode-type DIRECTORY)) (allow sysctl-read) "
            "(allow file-read* " + reads + ' (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")) '
            "(allow file-write* " + writes + ' (literal "/dev/null"))')


def json_value(value):
    # Equality is on JSON types too: true is not the integer 1. NaN is refused.
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate test field")
        value[key] = item
    return value


def load_cases(raw):
    if not raw or len(raw) > MAX_TESTS:
        raise ValueError("测试文件需为不超过32千字节的JSON文件，原件仍保留。")
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_object)
        if (not isinstance(value, dict) or set(value) != {"function", "cases"}
                or not isinstance(value["function"], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", value["function"])
                or not isinstance(value["cases"], list) or not 1 <= len(value["cases"]) <= MAX_CASES):
            raise ValueError()
        for case in value["cases"]:
            if (not isinstance(case, dict) or set(case) != {"label", "args", "kwargs", "expected"}
                    or not isinstance(case["label"], str) or not 1 <= len(case["label"]) <= 100
                    or not isinstance(case["args"], list) or not isinstance(case["kwargs"], dict)
                    or any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", k) for k in case["kwargs"])):
                raise ValueError()
        json_value(value)
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError("测试文件格式不正确。请使用函数名、输入和预期结果，不填写命令或文件路径。") from None


def run_case(source, function, case):
    if not available():
        raise ValueError("这台电脑还不能安全运行代码测试；原文件保留，没有执行。")
    # The uploaded program does not receive the expected answer or test label.
    payload = json_value({"source": source, "function": function, "args": case["args"], "kwargs": case["kwargs"]}).encode()
    if len(payload) > 170000:
        raise ValueError("代码与输入合计过大，请缩小函数或测试数据；原文件仍保留。")
    with tempfile.TemporaryDirectory(prefix="synplex-code-") as scratch:
        output, error = Path(scratch) / "result", Path(scratch) / "error"
        with output.open("xb") as out, error.open("xb") as err:
            os.chmod(output, 0o600)
            os.chmod(error, 0o600)
            command = ["/usr/bin/sandbox-exec", "-p", sandbox_profile(output, error),
                       str(Path(sys.executable).resolve()), "-I", "-S", "-B", "-c", RUNTIME + WORKER]
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                cwd=scratch, start_new_session=True, env={"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"})
            try:
                child.communicate(payload, timeout=3)
            except BaseException:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)
                return {"label": case["label"], "status": "incomplete", "actual": None, "expected": case["expected"]}
        status, actual = "incomplete", None
        if child.returncode == 0 and output.stat().st_size <= MAX_OUTPUT and error.stat().st_size <= MAX_OUTPUT:
            try:
                result = json.loads(output.read_bytes())
                if isinstance(result, dict) and set(result) == {"ok", "actual"} and result["ok"] is True:
                    actual = result["actual"]
                    status = "passed" if json_value(actual) == json_value(case["expected"]) else "failed"
            except (ValueError, UnicodeError, TypeError, RecursionError):
                pass
        return {"label": case["label"], "status": status, "actual": actual, "expected": case["expected"]}


def check_functions(source_metadata, raw, test_metadata, test_raw):
    if (source_metadata["name"].rsplit(".", 1)[-1].lower() != "py"
            or test_metadata["name"].rsplit(".", 1)[-1].lower() != "json"
            or not raw or len(raw) > MAX_SOURCE or b"\x00" in raw):
        raise ValueError("请选择不超过128千字节的Python代码，以及单独的JSON测试文件。")
    try:
        source = raw.decode("utf-8-sig", errors="strict")
    except UnicodeError:
        raise ValueError("代码文件不是UTF-8文字，请转换编码后再测试。") from None
    specification = load_cases(test_raw)
    guarded = prepare_source(source)
    cases = [run_case(guarded, specification["function"], case) for case in specification["cases"]]
    return {"kind": "bounded_python_functions", "sourceSha256": hashlib.sha256(raw).hexdigest(),
            "testsSha256": hashlib.sha256(test_raw).hexdigest(), "function": specification["function"],
            "cases": cases, "passed": all(c["status"] == "passed" for c in cases),
            "complete": all(c["status"] != "incomplete" for c in cases), "codeExecution": "attempted_in_restricted_subset",
            "isolation": "macos_seatbelt_deny_default", "freshProcessPerCase": True,
            "expectedValuesPassedToProgram": False, "dependencyChecks": "not_run",
            "allocationGuards": "bounded_values_and_operations", "kernelMemoryLimit": False}
