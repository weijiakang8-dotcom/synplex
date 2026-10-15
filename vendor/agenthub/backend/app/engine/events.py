"""统一 Event Contract（Frozen Core）。

前端只消费本协议，不感知后端 Runtime 差异。
事件名：status / token / step / tool_call / tool_result / approval_required /
error / execution_completed / execution_failed / waiting_for_approval / done。
"""

from __future__ import annotations

import time
import uuid
from typing import Any

EVENT_STATUS = "status"
EVENT_TOKEN = "token"
EVENT_STEP = "step"
EVENT_TOOL_CALL = "tool_call"
EVENT_TOOL_RESULT = "tool_result"
EVENT_APPROVAL_REQUIRED = "approval_required"
EVENT_ERROR = "error"
EVENT_COMPLETED = "execution_completed"
EVENT_FAILED = "execution_failed"
EVENT_WAITING = "waiting_for_approval"
EVENT_DONE = "done"
# 调度中心（二次装修新增）
EVENT_COMPLEXITY = "complexity"
EVENT_ROUTING = "routing"
EVENT_CLARIFICATION_REQUIRED = "clarification_required"


def build_event(
    event: str,
    execution_id: str,
    *,
    correlation_id: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    return {
        "event_id": str(uuid.uuid4()),
        "execution_id": execution_id,
        "correlation_id": correlation_id,
        "ts": time.time_ns(),
        "event": event,
        **fields,
    }


__all__ = [
    "EVENT_APPROVAL_REQUIRED",
    "EVENT_CLARIFICATION_REQUIRED",
    "EVENT_COMPLETED",
    "EVENT_COMPLEXITY",
    "EVENT_DONE",
    "EVENT_ERROR",
    "EVENT_FAILED",
    "EVENT_ROUTING",
    "EVENT_STATUS",
    "EVENT_STEP",
    "EVENT_TOKEN",
    "EVENT_TOOL_CALL",
    "EVENT_TOOL_RESULT",
    "EVENT_WAITING",
    "build_event",
]
