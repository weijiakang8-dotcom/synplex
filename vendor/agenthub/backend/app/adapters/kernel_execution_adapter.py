from __future__ import annotations

import uuid
from typing import Any

from app.adapters.errors import UnsupportedKernelWorkflowError
from app.kernel.artifact.store import ArtifactStore
from app.kernel.capability.contracts import build_standard_registry
from app.kernel.capability.model import CapabilityId
from app.kernel.evidence.model import EvidenceLevel
from app.kernel.goal.model import Goal, GoalPredicate
from app.kernel.plan.model import Plan
from app.kernel.runtime.model import RuntimeInput
from app.kernel.state.model import (
    ExecutionContext,
    KnowledgeState,
    ObservedWorldState,
    State,
)
from app.kernel.task.model import Task

_SUPPORTED_CAPABILITIES = {CapabilityId.OBSERVE, CapabilityId.MUTATE}


def _resolve_template(value: Any, execution_id: uuid.UUID) -> Any:
    if isinstance(value, str):
        return value.replace("{execution_id}", str(execution_id))
    if isinstance(value, list):
        return [_resolve_template(item, execution_id) for item in value]
    if isinstance(value, dict):
        return {
            key: _resolve_template(item, execution_id) for key, item in value.items()
        }
    return value


def kernel_plan(workflow) -> dict | None:
    dag = getattr(workflow, "dag_definition", None) or {}
    if not isinstance(dag, dict):
        return None
    plan = dag.get("kernel_plan")
    return plan if isinstance(plan, dict) else None


def is_kernel_workflow(workflow) -> bool:
    return kernel_plan(workflow) is not None


def build_runtime_input(
    execution,
    workflow,
    effect_port,
) -> RuntimeInput:
    """将 live Production Execution/Workflow 映射为 Kernel RuntimeInput。

    只支持显式 `dag_definition.kernel_plan`；无法映射时抛
    UnsupportedKernelWorkflowError，绝不猜测。
    """
    plan = kernel_plan(workflow)
    if plan is None:
        raise UnsupportedKernelWorkflowError(
            "workflow has no explicit kernel_plan; NOT_SUPPORTED_IN_KERNEL_MODE"
        )

    goal_data = plan.get("goal")
    if not isinstance(goal_data, dict) or not goal_data.get("predicate"):
        raise UnsupportedKernelWorkflowError("kernel_plan.goal.predicate is required")

    goal = Goal(
        goal_id=goal_data.get("goal_id", "kernel_production_goal"),
        predicate=GoalPredicate(
            name=str(goal_data["predicate"]),
            params=goal_data.get("params") or {},
        ),
        required_evidence=EvidenceLevel(
            goal_data.get("required_evidence", "L3_OBSERVED")
        ),
    )

    tasks: list[Task] = []
    raw_tasks = plan.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise UnsupportedKernelWorkflowError("kernel_plan.tasks is required")

    for raw_task in raw_tasks:
        if not isinstance(raw_task, dict):
            raise UnsupportedKernelWorkflowError(
                "kernel_plan.tasks entries must be objects"
            )
        task_id = str(raw_task.get("task_id") or "")
        capability_raw = str(raw_task.get("capability_id") or "")
        if not task_id or not capability_raw:
            raise UnsupportedKernelWorkflowError(
                "kernel_plan task requires task_id and capability_id"
            )

        try:
            capability_id = CapabilityId(capability_raw)
        except ValueError as exc:
            raise UnsupportedKernelWorkflowError(
                f"unsupported kernel capability: {capability_raw}"
            ) from exc

        if capability_id not in _SUPPORTED_CAPABILITIES:
            raise UnsupportedKernelWorkflowError(
                f"capability {capability_id.value} is not supported in kernel mode"
            )

        idempotency_key = str(
            raw_task.get("idempotency_key") or f"{execution.id}:{task_id}"
        )
        payload = _resolve_template(
            raw_task.get("payload") or {},
            execution.id,
        )
        tasks.append(
            Task(
                task_id=task_id,
                capability_id=capability_id,
                input_arguments={
                    "idempotency_key": idempotency_key,
                    "payload": payload,
                },
            )
        )

    return RuntimeInput(
        initial_state=State(
            knowledge=KnowledgeState(),
            observed=ObservedWorldState(),
            context=ExecutionContext(run_id=str(execution.id)),
        ),
        plan=Plan(
            plan_id=f"kernel:{execution.id}",
            tasks=tasks,
        ),
        goal=goal,
        capability_registry=build_standard_registry(),
        artifact_store=ArtifactStore(),
        effect_port=effect_port,
    )


__all__ = [
    "build_runtime_input",
    "is_kernel_workflow",
    "kernel_plan",
]
