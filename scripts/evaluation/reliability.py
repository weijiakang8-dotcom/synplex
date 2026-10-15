"""Calculate evidence supplied by the caller; never run an agent or call a model.

CRS arithmetic follows the previously reviewed ClawArena report.py at
630efd8a0d1dc8189718226c7da158cbe4c2fe64. This is a custom product report,
not an official benchmark submission. Missing observations remain unmeasured.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def rows(value):
    require(isinstance(value, list) and len(value) <= 10000, "证据列表格式不正确或数量过多。")
    return value


def unique(values, key="id"):
    identifiers = [row.get(key) if isinstance(row, dict) else None for row in rows(values)]
    require(all(isinstance(item, str) and item and len(item) <= 256 for item in identifiers), "每条证据需要明确编号。")
    require(len(set(identifiers)) == len(identifiers), "证据编号重复，不能重复计入成绩。")
    return {row[key]: row for row in values}


def measured_number(value, maximum=None):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0 and (maximum is None or value <= maximum)


def mean(values):
    return round(sum(values) / len(values), 4) if values else None


def streaks(successes, expected):
    result, current = [], 0
    for success in successes:
        if success == expected:
            current += 1
        elif current:
            result.append(current)
            current = 0
    if current:
        result.append(current)
    return result


def scenario_metrics(scenario):
    order = rows(scenario["order"])
    expected = unique(order)
    observations = unique(scenario["observations"])
    require(set(observations) <= set(expected), "观测包含未在验收顺序中登记的轮次。")
    for entry in order:
        require(entry.get("type") in {"MC", "EC"}, "轮次需要标明推理或执行验证。")
    scores = [observations.get(entry["id"], {}).get("score") for entry in order]
    require(all(score is None or measured_number(score, 1) for score in scores), "正确率必须在零到一之间，未测用空值。")
    missing = [entry["id"] for entry, score in zip(order, scores) if score is None]
    result = {"id": scenario["id"], "rounds": len(order), "measuredRounds": len(order) - len(missing),
              "missingRounds": missing, "status": "complete" if order and not missing else "unmeasured" if not observations else "incomplete",
              "tcr": None, "sc": None, "fd": None, "robustness": None, "crs": None,
              "successStreaks": None, "failureStreaks": None, "byType": {}}
    if not order or missing:
        return result
    successes = [score >= 1 for score in scores]
    success_runs, failure_runs = streaks(successes, True), streaks(successes, False)
    coherence = lambda runs: (sum(runs) - len(runs)) / (len(order) - 1) if len(order) > 1 and runs else 0
    sc, fd, tcr = round(coherence(success_runs), 4), round(1 - coherence(failure_runs), 4), mean(scores)
    result.update(tcr=tcr, sc=sc, fd=fd, robustness=round(sc * fd, 4), crs=round((tcr + sc * fd) / 2, 4),
                  successStreaks=success_runs, failureStreaks=failure_runs)
    for kind in ["MC", "EC"]:
        selected = [score for entry, score in zip(order, scores) if entry["type"] == kind]
        result["byType"][kind] = {"count": len(selected), "scoreSum": sum(selected), "tcr": mean(selected)}
    return result


def benchmark_metrics(scenarios):
    unique(scenarios)
    results = [scenario_metrics(scenario) for scenario in scenarios]
    complete = bool(results) and all(result["status"] == "complete" for result in results)
    summary = {"scenarios": len(results), "rounds": sum(r["rounds"] for r in results),
               "measuredRounds": sum(r["measuredRounds"] for r in results),
               "status": "complete" if complete else "incomplete" if any(r["measuredRounds"] for r in results) else "unmeasured",
               "tcr": None, "sc": None, "fd": None, "robustness": None, "crs": None, "meanScenarioCrs": None,
               "byType": {}}
    if complete:
        for key in ["tcr", "sc", "fd", "robustness"]:
            summary[key] = mean([result[key] for result in results])
        summary["crs"] = round((summary["tcr"] + summary["sc"] * summary["fd"]) / 2, 4)
        summary["meanScenarioCrs"] = mean([result["crs"] for result in results])
        for kind in ["MC", "EC"]:
            count = sum(result["byType"][kind]["count"] for result in results)
            score_sum = sum(result["byType"][kind]["scoreSum"] for result in results)
            summary["byType"][kind] = {"count": count, "tcr": round(score_sum / count, 4) if count else None}
    return {"summary": summary, "scenarios": results}


def repeat_metrics(tasks, k=3):
    require(type(k) is int and 1 <= k <= 10, "重复次数设置不正确。")
    unique(tasks)
    results, seen = [], set()
    for task in tasks:
        unique(task["runs"])
        independent = []
        for run in task["runs"]:
            require(run["id"] not in seen, "同一运行不能计入不同任务。")
            seen.add(run["id"])
            require(type(run.get("independent")) is bool and (run.get("passed") is None or type(run["passed"]) is bool), "运行需要独立性和验收结果，未测用空值。")
            fingerprint = run.get("conditionsHash")
            require(isinstance(fingerprint, str) and len(fingerprint) == 64 and all(c in "0123456789abcdef" for c in fingerprint), "需要冻结材料、版本、模型、权限和初始环境的条件指纹。")
            if run["independent"]:
                independent.append(run)
        n, c = len(independent), sum(run["passed"] is True for run in independent)
        status = "complete"
        if len({run["conditionsHash"] for run in independent}) > 1:
            status = "mixed_conditions"
        elif any(run["passed"] is None for run in independent):
            status = "incomplete"
        elif n < k:
            status = "insufficient_runs"
        denominator = math.comb(n, k) if status == "complete" else None
        results.append({"id": task["id"], "status": status, "independentRuns": n, "successes": c,
                        "excludedNonIndependentRuns": len(task["runs"]) - n,
                        "passPowerK": math.comb(c, k) / denominator if denominator else None,
                        "passAtK": 1 - math.comb(n-c, k) / denominator if denominator else None})
    complete = bool(results) and all(result["status"] == "complete" for result in results)
    return {"k": k, "tasks": results, "status": "complete" if complete else "unmeasured" if not results else "incomplete",
            "passPowerK": mean([r["passPowerK"] for r in results]) if complete else None,
            "passAtK": mean([r["passAtK"] for r in results]) if complete else None}


def recovery_metrics(faults):
    unique(faults)
    outcomes = ["automatic", "assisted", "blocked", "unknown", "unrecovered"]
    counts = dict.fromkeys(outcomes, 0)
    categories, durations, duplicates = {}, [], []
    for fault in faults:
        outcome, category = fault.get("outcome"), fault.get("category")
        require(outcome in counts and isinstance(category, str) and category and len(category) <= 128, "故障需要明确类别与恢复结论。")
        require(fault.get("duplicateSideEffect") is None or type(fault["duplicateSideEffect"]) is bool, "重复副作用结果必须明确，未知用空值。")
        duration = fault.get("recoveryMs")
        require(duration is None or measured_number(duration, 315576000000), "恢复时间必须有效，未知用空值。")
        counts[outcome] += 1
        categories.setdefault(category, dict.fromkeys(outcomes, 0))[outcome] += 1
        duplicates.append(fault.get("duplicateSideEffect"))
        if outcome in {"automatic", "assisted"} and duration is not None:
            durations.append(duration)
    n = len(faults)
    return {"faults": n, "counts": counts, "byCategory": categories,
            "rates": {key: count / n if n else None for key, count in counts.items()},
            "duplicateSideEffects": sum(value is True for value in duplicates),
            "duplicateObservations": sum(value is not None for value in duplicates),
            "duplicateRate": sum(value is True for value in duplicates) / n if n and all(value is not None for value in duplicates) else None,
            "recoveryTime": {"measured": len(durations), "medianMs": statistics.median(durations) if durations else None,
                             "p95Ms": sorted(durations)[math.ceil(len(durations)*.95)-1] if len(durations) >= 20 else None}}


def calculate(data):
    require(isinstance(data, dict) and data.get("format") == "synplex.reliability-input/1", "可靠性证据格式不正确。")
    require(data.get("provenance") in {"fixture", "product_evidence"}, "必须区分示例和真实产品证据。")
    return {"format": "synplex.reliability-report/1", "provenance": data["provenance"], "officialBenchmark": False,
            "notice": "只计算输入证据；不认证证据来源，不代表官方337轮、真实模型或市场成绩。",
            "benchmark": benchmark_metrics(data["scenarios"]), "repeats": repeat_metrics(data["repeatTasks"]),
            "recovery": recovery_metrics(data["faults"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    require(args.input.stat().st_size <= 8 * 1024 * 1024, "证据文件超过读取上限。")
    result = calculate(json.loads(args.input.read_text()))
    # Exclusive creation preserves previous measurements, even when input/output
    # paths or links were selected incorrectly. No parent directory is invented.
    encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(encoded)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        print("可靠性报告未生成：请核对证据格式并选择新的输出文件，原记录不会覆盖。", file=sys.stderr)
        sys.exit(1)
