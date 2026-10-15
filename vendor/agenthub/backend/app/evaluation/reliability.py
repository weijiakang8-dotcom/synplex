"""Score fixed tasks against durable runs; never initiate model calls or effects.

Usage from backend: python -m app.evaluation.reliability --assignments /path/runs.json
Assignments: [{"case_id":"inn-agent", "execution_id":"uuid",
               "content_review":"passed|failed|unreviewed"}]
Report goes to stdout. Save important interpretation in Obsidian.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import uuid
from pathlib import Path

from sqlalchemy import select

from app.artifacts.service import artifact_inventory
from app.database import async_session_factory
from app.models import Execution, UsageEvent

DEFAULT_CASES = Path(__file__).resolve().parents[2] / "evaluation" / "tasks.json"


def assess(case: dict, execution, receipts: list, artifacts: list) -> dict:
    checkpoint = execution.checkpoint_data or {}
    delivery = checkpoint.get("delivery") or {}
    status = delivery.get("status", "unverified")
    blockers = delivery.get("blockers") or []
    errors = []
    if status not in case["statuses"]:
        errors.append("delivery_status")
    if (
        status == "completed"
        and getattr(execution.status, "value", execution.status) != "completed"
    ):
        errors.append("lifecycle_status")
    if (
        case.get("requires_explanation_if_incomplete")
        and status in {"partial", "blocked"}
        and (
            not blockers
            or any(not b.get("reason") or not b.get("next_actions") for b in blockers)
        )
    ):
        errors.append("missing_actionable_explanation")
    if case.get("blocker_codes") and not any(
        b.get("code") in case["blocker_codes"] for b in blockers
    ):
        errors.append("expected_blocker")
    formats = {a["format"] for a in artifacts if a.get("verified")}
    if not set(case.get("formats") or []) <= formats:
        errors.append("missing_verified_format")
    if "agent" in (case.get("deliverables") or []) and not any(
        isinstance(value, dict)
        and value.get("status") in {"success", "duplicate"}
        and (value.get("data") or {}).get("agent_id")
        for value in (checkpoint.get("node_outputs") or {}).values()
    ):
        errors.append("missing_agent_receipt")
    # A receipt certifies execution, not that the saved Agent matches the user's goal.
    if not execution.final_output:
        errors.append("missing_output")
    latency = None
    if execution.created_at and execution.completed_at:
        latency = max(
            0, (execution.completed_at - execution.created_at).total_seconds()
        )
    known_cost = sum(float(r.cost) for r in receipts if r.cost is not None)
    unknown_calls = sum(r.cost is None for r in receipts)
    estimated_calls = sum(
        r.status in {"estimated", "partial_estimate"} for r in receipts
    )
    return {
        "case_id": case["id"],
        "kind": case["kind"],
        "execution_id": str(execution.id),
        "protocol_pass": not errors,
        "errors": errors,
        "delivery_status": status,
        "content_review": "unreviewed",
        "latency_seconds": latency,
        "llm_calls": len(receipts),
        "known_cost_cny": round(known_cost, 8),
        "total_cost_cny": (
            round(known_cost, 8) if receipts and not unknown_calls else None
        ),
        "cost_complete": bool(receipts) and unknown_calls == 0,
        "unknown_price_calls": unknown_calls,
        "estimated_usage_calls": estimated_calls,
    }


def summarize(results: list, total_cases: int) -> dict:
    tested = [r for r in results if r.get("protocol_pass") is not None]
    business = [r for r in tested if r["kind"] == "business"]
    certified = [
        r
        for r in business
        if r["protocol_pass"]
        and r["delivery_status"] == "completed"
        and r["content_review"] == "passed"
    ]
    reviewed = [r for r in business if r["content_review"] != "unreviewed"]
    return {
        "case_count": total_cases,
        "tested_count": len(tested),
        "protocol_pass_rate": (
            sum(r["protocol_pass"] for r in tested) / len(tested) if tested else None
        ),
        "business_tested": len(business),
        "business_content_reviewed": len(reviewed),
        "confirmed_business_completion_rate": (
            len(certified) / len(business) if business else None
        ),
        "known_cost_cny": round(sum(r["known_cost_cny"] for r in tested), 8),
        "cost_complete": len(tested) == total_cases
        and all(r["cost_complete"] for r in tested),
        "note": "故障演练不计业务完成率；未人工核验的内容不认证完成；估算用量不是供应商账单。",
        "results": results,
    }


async def evaluate(cases: list, assignments: list) -> dict:
    ids = {case["id"] for case in cases}
    mappings = {}
    used = set()
    for item in assignments:
        case_id = item["case_id"]
        execution_id = uuid.UUID(item["execution_id"])
        review = item.get("content_review", "unreviewed")
        if case_id not in ids or case_id in mappings or execution_id in used:
            raise ValueError("Unknown/duplicate task or reused execution")
        if review not in {"passed", "failed", "unreviewed"}:
            raise ValueError("Invalid content_review")
        mappings[case_id] = (execution_id, review)
        used.add(execution_id)
    results = []
    async with async_session_factory() as session:
        for case in cases:
            mapping = mappings.get(case["id"])
            execution = await session.get(Execution, mapping[0]) if mapping else None
            if execution is None:
                results.append(
                    {
                        "case_id": case["id"],
                        "kind": case["kind"],
                        "protocol_pass": None,
                        "status": "untested",
                    }
                )
                continue
            receipts = list(
                (
                    await session.execute(
                        select(UsageEvent).where(
                            UsageEvent.execution_id == execution.id
                        )
                    )
                )
                .scalars()
                .all()
            )
            artifacts, missing = await artifact_inventory(
                execution.id, execution.user_id, execution.organization_id
            )
            result = assess(case, execution, receipts, artifacts)
            if missing and result["delivery_status"] == "completed":
                result["protocol_pass"] = False
                result["errors"].append("artifact_storage")
            result["content_review"] = mapping[1]
            results.append(result)
    return summarize(results, len(cases))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--assignments", type=Path, required=True)
    args = parser.parse_args()
    report = asyncio.run(
        evaluate(
            json.loads(args.cases.read_text()), json.loads(args.assignments.read_text())
        )
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return (
        1 if any(r.get("protocol_pass") is not True for r in report["results"]) else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
