from __future__ import annotations

from typing import Any

from app.kernel.capability.predicates import evaluate_predicate
from app.kernel.task.model import Task


def validate_postconditions(
    task: Task,
    *,
    state,
    artifact_store,
    args: dict[str, Any],
    output: Any,
) -> bool:
    """局部 Postcondition 验证：只验证单个 Task/Capability 的输出。

    这是 Phase 2.2 的局部验证，不是 Phase 2.4 的全局 GoalEvaluator。
    """
    for predicate in task.postconditions:
        if not evaluate_predicate(
            predicate,
            state=state,
            artifact_store=artifact_store,
            args=args,
            output=output,
        ):
            return False
    return True


__all__ = ["validate_postconditions"]
