from __future__ import annotations

from app.kernel.capability.predicates import is_known_predicate
from app.kernel.capability.registry import CapabilityRegistry
from app.kernel.plan.errors import CycleDetectedError, PlanValidationError
from app.kernel.plan.model import Plan, PlanValidationResult
from app.kernel.state.model import State


def topological_order(plan: Plan) -> list[str]:
    """返回确定性的任务执行顺序；发现环则抛 CycleDetectedError。"""
    task_ids = [task.task_id for task in plan.tasks]
    id_set = set(task_ids)
    indegree = {task_id: 0 for task_id in task_ids}
    dependents = {task_id: [] for task_id in task_ids}

    for dependency in plan.dependencies:
        if dependency.task_id not in id_set or dependency.on_task_id not in id_set:
            raise PlanValidationError(
                "dependency references unknown task: "
                f"{dependency.task_id} -> {dependency.on_task_id}"
            )
        if dependency.task_id == dependency.on_task_id:
            raise CycleDetectedError(f"self dependency detected: {dependency.task_id}")
        indegree[dependency.task_id] += 1
        dependents[dependency.on_task_id].append(dependency.task_id)

    queue = sorted(task_id for task_id in task_ids if indegree[task_id] == 0)
    order: list[str] = []
    while queue:
        task_id = queue.pop(0)
        order.append(task_id)
        for dependent in sorted(dependents[task_id]):
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                queue.append(dependent)
                queue.sort()

    if len(order) != len(task_ids):
        raise CycleDetectedError("plan contains a dependency cycle")
    return order


def validate_plan(
    plan: Plan,
    state: State,
    registry: CapabilityRegistry,
) -> PlanValidationResult:
    """执行前的结构校验：能力注册、依赖存在、无环、谓词可判定、任务 id 唯一。"""
    issues: list[str] = []

    task_ids = [task.task_id for task in plan.tasks]
    if len(task_ids) != len(set(task_ids)):
        issues.append("duplicate task_id in plan")

    for task in plan.tasks:
        if registry.get(task.capability_id) is None:
            issues.append(f"unregistered capability: {task.capability_id.value}")
        for predicate in [*task.preconditions, *task.postconditions]:
            if not is_known_predicate(predicate.name):
                issues.append(
                    f"unknown predicate in task {task.task_id}: {predicate.name}"
                )

    id_set = set(task_ids)
    for dependency in plan.dependencies:
        if dependency.task_id not in id_set or dependency.on_task_id not in id_set:
            issues.append(
                f"dependency references unknown task: "
                f"{dependency.task_id} -> {dependency.on_task_id}"
            )

    try:
        topological_order(plan)
    except CycleDetectedError as exc:
        issues.append(str(exc))
    except PlanValidationError as exc:
        issues.append(str(exc))

    return PlanValidationResult(valid=not issues, issues=issues)


__all__ = ["topological_order", "validate_plan"]
