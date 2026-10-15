"""File-backed syntax parsing and opt-in, OS-isolated small Python function tests.

Neither entry point accepts caller paths, commands or dependency installation.
"""
import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

MAX_BYTES = 128 * 1024
PYTHON_PARSER = r'''
import ast,json,sys
try:
    ast.parse(sys.stdin.buffer.read().decode('utf-8-sig'), filename='<uploaded-source>')
    result={'syntaxValid':True,'line':None,'column':None}
except SyntaxError as error:
    result={'syntaxValid':False,'line':error.lineno,'column':error.offset}
except (UnicodeError,ValueError,RecursionError,MemoryError):
    result={'incomplete':True}
result['parserVersion']='Python '+sys.version.split()[0]
print(json.dumps(result))
'''


class CodeParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    file_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    language: Literal["python", "javascript", "javascript_module"]
    title: str = Field(default="代码语法检查", min_length=1, max_length=100)


@tool(args_schema=CodeParams)
async def check_task_code(file_key: str, language: str, title: str = "代码语法检查") -> dict:
    """检查本次上传的Python或JavaScript文件语法并生成可下载报告。只解析，不运行代码、不加载依赖、不验证业务逻辑；javascript表示CommonJS，javascript_module表示ES模块。"""
    raise PermissionError("Use ToolExecutor")


def parser_process(command, raw):
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True, env={"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"})
    try:
        stdout, stderr = child.communicate(raw, timeout=5)
    except BaseException:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)
        raise ValueError("代码检查未及时完成，请缩小文件后再试；原文件仍保留。") from None
    if len(stdout) + len(stderr) > 512 * 1024:
        raise ValueError("代码检查返回内容过多，未认定检查通过；原文件仍保留。")
    return child.returncode, stdout, stderr


def python_syntax(raw):
    code, stdout, _ = parser_process([sys.executable, "-I", "-B", "-c", PYTHON_PARSER], raw)
    if code or len(stdout) > 4096:
        raise ValueError("Python语法检查未完成，没有运行源代码。")
    try:
        result = json.loads(stdout)
    except (ValueError, UnicodeError):
        raise ValueError("Python语法检查未返回有效结果，没有认定通过。") from None
    if result.get("incomplete") or type(result.get("syntaxValid")) is not bool:
        raise ValueError("Python文件暂时无法完整检查，原文件仍保留。")
    return result


def javascript_syntax(raw, language):
    node = shutil.which("node")
    if not node:
        raise ValueError("代码检查程序尚未就绪，请先完成工作台环境检查。")
    version = subprocess.run([node, "--version"], capture_output=True, timeout=3,
        env={"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"}, check=True).stdout.decode().strip()
    code, _, stderr = parser_process([node, "--max-old-space-size=96", "--check", "--input-type=" +
        ("module" if language == "javascript_module" else "commonjs")], raw)
    if code == 0:
        return {"syntaxValid": True, "line": None, "column": None, "parserVersion": "Node.js " + version}
    error = stderr.decode("utf-8", errors="replace")
    location = re.search(r"\[stdin\]:(\d+)\n", error)
    if code != 1 or "SyntaxError:" not in error or not location:
        raise ValueError("JavaScript语法检查未完成，没有运行源代码。")
    # Never include parser stderr, uploaded source lines, paths or identifiers.
    return {"syntaxValid": False, "line": int(location[1]), "column": None, "parserVersion": "Node.js " + version}


def check_syntax(metadata, raw, language):
    extensions = {"python": {"py", "txt"}, "javascript": {"js", "cjs", "txt"},
        "javascript_module": {"js", "mjs", "txt"}}
    if language not in extensions or metadata["name"].rsplit(".", 1)[-1].lower() not in extensions[language]:
        raise ValueError("所选语言与文件类型不一致，请核对语言和原文件。")
    if not raw or len(raw) > MAX_BYTES or b"\x00" in raw:
        raise ValueError("请使用不超过128千字节的非空文字代码文件，原文件仍保留。")
    try:
        raw.decode("utf-8-sig", errors="strict")
    except UnicodeError:
        raise ValueError("代码文件不是UTF-8文字，请转换编码后再检查。") from None
    result = python_syntax(raw) if language == "python" else javascript_syntax(raw, language)
    return {**result, "kind": "syntax_only", "language": language, "sourceName": metadata["name"],
        "sourceSha256": hashlib.sha256(raw).hexdigest(), "sourceBytes": len(raw), "codeExecuted": False,
        "functionalTests": "not_run", "dependencyChecks": "not_run"}


def report(evidence):
    name = evidence["sourceName"].replace("\r", " ").replace("\n", " ").replace('`', '')
    location = ""
    if not evidence["syntaxValid"]:
        location = f"\n发现位置：第{evidence['line']}行。请核对这一行及相邻位置的语法和符号。\n"
    return ("# 代码语法检查\n\n结果：" + ("语法检查通过" if evidence["syntaxValid"] else "发现语法问题") +
        f"\n\n原文件：{name}\n\n文件指纹：{evidence['sourceSha256']}\n\n检查程序：{evidence['parserVersion']}\n" + location +
        "\n本次只检查语法，没有运行代码、加载项目依赖或进行功能测试。语法通过不代表程序运行正确。原文件未修改。\n")


async def run_code_check(params, organization_id):
    from task_tools import authorized_file
    from app.engine.delivery_tools import run_export_document
    request = CodeParams.model_validate(params)
    _, _, metadata, raw = await authorized_file(organization_id, request.file_key)
    evidence = await asyncio.to_thread(check_syntax, metadata, raw, request.language)
    await authorized_file(organization_id, request.file_key)
    artifact = await run_export_document({"title": request.title, "content": report(evidence), "format": "md"}, organization_id)
    return {**artifact, "data": {**artifact["data"], "validation": evidence}}


class FunctionParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    code_file_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    tests_file_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    title: str = Field(default="代码功能测试", min_length=1, max_length=100)


@tool(args_schema=FunctionParams)
async def test_task_python(code_file_key: str, tests_file_key: str, title: str = "代码功能测试") -> dict:
    """用选中的Python代码和单独JSON测试文件实际测试小型函数，生成报告。测试文件含function和cases，cases每项有label、args列表、kwargs对象、expected。最多6例；支持基本运算、条件、循环、len/sum/min/max/abs/round/range/sorted，不运行导入、类、外部依赖或完整项目。通过只证明所选样本，不代表全部功能正确。不接受命令、路径或临时编造的预期答案。"""
    raise PermissionError("Use ToolExecutor")


def function_report(evidence):
    lines = ["# 代码功能测试", "", "结果：" + ("所选样本全部通过" if evidence["passed"] else "有样本未通过或未能完成"),
             "", "代码指纹：" + evidence["sourceSha256"], "测试文件指纹：" + evidence["testsSha256"], ""]
    labels = {"passed": "通过", "failed": "结果不符合预期", "incomplete": "未完成，不能认定通过"}
    for number, case in enumerate(evidence["cases"], 1):
        lines.extend([f"## 样本 {number}", case["label"].replace("\n", " ").replace("\r", " "), labels[case["status"]], ""])
        for name, value in [("预期", case["expected"]), ("实际", case["actual"])]:
            if name == "实际" and case["status"] == "incomplete":
                lines.append("实际：未取得可核实的结果。")
                continue
            text = json.dumps(value, ensure_ascii=False, allow_nan=False)
            lines.append(name + "：" + (text[:1500] + "…（节选，完整预期见测试原件）" if len(text) > 1500 else text))
        lines.append("")
    lines.extend(["每个样本在新的隔离进程测试；预期答案未交给被测程序。文件与网络访问、其他进程控制均禁止。",
                  "仅适用于受限的小型Python函数，有运算步数、数据大小、耗时和输出限制。不是任意代码、依赖安装或完整项目测试。",
                  "本机没有可用的内核硬内存上限；使用受限语法与分配守卫，超出范围明确未完成，不执行任意Python。",
                  "通过只证明所选测试样本的返回结果符合预期，不证明全部业务正确或样本独立。原文件未修改。"])
    return "\n".join(lines)


async def run_function_check(params, organization_id):
    from task_tools import authorized_file
    from app.engine.delivery_tools import run_export_document
    from python_cases import check_functions
    request = FunctionParams.model_validate(params)
    _, _, code, raw = await authorized_file(organization_id, request.code_file_key)
    _, _, tests, test_raw = await authorized_file(organization_id, request.tests_file_key)
    evidence = await asyncio.to_thread(check_functions, code, raw, tests, test_raw)
    await authorized_file(organization_id, request.code_file_key)
    await authorized_file(organization_id, request.tests_file_key)
    artifact = await run_export_document({"title": request.title, "content": function_report(evidence), "format": "md"}, organization_id)
    # Limit model-visible values; full originals and immutable fingerprints remain.
    checks = [{"label": c["label"], "status": c["status"]} for c in evidence["cases"]]
    return {**artifact, "data": {**artifact["data"], "validation": {**evidence, "cases": checks}}}
