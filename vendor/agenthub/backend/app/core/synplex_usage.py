"""External runner receipts stay in USD; never mix them with legacy CNY quotas."""

from __future__ import annotations

import math


def summarize_runner_usage(rows) -> dict:
    known = 0.0
    unknown = 0
    tokens = 0
    receipts = 0
    for row in rows:
        value = row.snapshot or {}
        ledger = value.get("ledger") or {}
        cost = ledger.get("actualCost")
        if (
            cost is None
            or not isinstance(cost, (int, float))
            or not math.isfinite(cost)
        ):
            unknown += 1
        else:
            known += max(0.0, cost)
        tokens += int(ledger.get("tokenTotal") or 0)
        receipts += len(ledger.get("rows") or [])
    return {
        "tasks": len(rows),
        "receipts": receipts,
        "tokens": tokens,
        "known_cost_usd": known,
        "unknown_cost_tasks": unknown,
        "total_cost_usd": known if unknown == 0 else None,
        "basis": "执行器回执与单价估算；单独计美元，不纳入旧人民币配额或推算节省额",
    }
