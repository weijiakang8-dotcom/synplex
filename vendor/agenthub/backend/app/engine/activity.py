"""Small, safe public projection of durable execution events for the chat UI."""

from __future__ import annotations

from typing import Any


def activity_event(payload: dict[str, Any]) -> dict[str, Any]:
    # Tool arguments, full results and internal prompts stay in the execution
    # record. A progress feed should never copy them into a public timeline.
    fields = (
        "event_id",
        "execution_id",
        "sequence",
        "ts",
        "event",
        "status",
        "node",
        "step_index",
        "step_id",
        "attempt",
        "phase",
        "description",
        "tool_call_id",
        "model_used",
        "agent_id",
        "ok",
        "outcome",
    )
    result = {key: payload[key] for key in fields if key in payload}
    if "description" in result:
        result["description"] = str(result["description"])[:200]
    tool = payload.get("tool_name") or payload.get("tool")
    if tool:
        result["tool_name"] = str(tool)[:100]
    if payload.get("event") == "approval_required":
        proposals = payload.get("side_effect_proposals") or []
        result["tools"] = [
            str(item.get("tool") or item.get("tool_name") or "")[:100]
            for item in proposals
            if isinstance(item, dict)
        ] or ([str(tool)[:100]] if tool else [])
    if payload.get("event") == "clarification_required":
        value = payload.get("clarification") or {}
        result["clarification"] = {
            key: value[key]
            for key in ("question", "options", "clarification_id")
            if key in value
        }
    return result
