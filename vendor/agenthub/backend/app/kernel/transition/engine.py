from __future__ import annotations

from typing import Any

from app.kernel.artifact.store import ArtifactStore
from app.kernel.capability.boundary import CapabilityBoundary
from app.kernel.capability.model import (
    CapabilityId,
    CapabilityOutcome,
    CapabilityResult,
    Classification,
)
from app.kernel.capability.predicates import evaluate_predicate
from app.kernel.capability.registry import CapabilityRegistry
from app.kernel.plan.model import Plan
from app.kernel.plan.validator import topological_order, validate_plan
from app.kernel.state.model import (
    ExecutionContext,
    KnowledgeState,
    ObservedWorldState,
    State,
)
from app.kernel.task.model import Task
from app.kernel.transition.model import (
    PlanExecutionResult,
    PlanExecutionStatus,
    TransitionResult,
    TransitionStatus,
)
from app.kernel.transition.validator import validate_postconditions


class TransitionEngine:
    """确定性 Task → State Transition 引擎。

    不做 Replan / Scheduler / GoalEvaluator / WorldSimulator。
    """

    def __init__(
        self,
        capability_registry: CapabilityRegistry,
        artifact_store: ArtifactStore,
    ) -> None:
        self._registry = capability_registry
        self._artifact_store = artifact_store
        self._boundary = CapabilityBoundary(capability_registry)

    def apply_task(self, state: State, task: Task) -> TransitionResult:
        definition = self._registry.get(task.capability_id)
        if definition is None:
            return self._reject(
                state,
                task,
                TransitionStatus.INVALID_CAPABILITY,
                error=f"unknown capability: {task.capability_id.value}",
            )

        for predicate in task.preconditions:
            if not evaluate_predicate(
                predicate,
                state=state,
                artifact_store=self._artifact_store,
                args=task.input_arguments,
                output=None,
            ):
                return self._reject(
                    state,
                    task,
                    TransitionStatus.PRECONDITION_FAILED,
                    error=f"task precondition failed: {predicate.name}",
                )

        for artifact_id in task.input_artifacts:
            if not self._artifact_store.has(artifact_id):
                return self._reject(
                    state,
                    task,
                    TransitionStatus.PRECONDITION_FAILED,
                    error=f"input artifact missing: {artifact_id}",
                )

        before = set(self._artifact_store.ids())
        result = self._boundary.apply(
            task.capability_id,
            state=state,
            args=task.input_arguments,
            artifact_store=self._artifact_store,
        )
        after = set(self._artifact_store.ids())
        produced = [
            ref
            for artifact_id in sorted(after - before)
            if (ref := self._artifact_store.get_ref(artifact_id)) is not None
        ]

        if result.outcome == CapabilityOutcome.PRECONDITION_FAILED:
            return self._reject(
                state,
                task,
                TransitionStatus.PRECONDITION_FAILED,
                error="capability precondition failed",
            )
        if result.outcome == CapabilityOutcome.POSTCONDITION_FAILED:
            return self._reject(
                state,
                task,
                TransitionStatus.POSTCONDITION_FAILED,
                error="capability postcondition failed",
            )

        output = self._raw_output(result)
        if not validate_postconditions(
            task,
            state=state,
            artifact_store=self._artifact_store,
            args=task.input_arguments,
            output=output,
        ):
            return self._reject(
                state,
                task,
                TransitionStatus.POSTCONDITION_FAILED,
                error="task postcondition failed",
            )

        next_state = self._project(state, task, result)
        command = (
            result.command
            if result.command is not None
            else task.input_arguments.get("command")
        )
        return TransitionResult(
            previous_state=state,
            next_state=next_state,
            task_id=task.task_id,
            capability_id=task.capability_id,
            status=TransitionStatus.APPLIED,
            produced_artifacts=produced,
            command=(
                command if result.classification == Classification.EFFECTFUL else None
            ),
            receipt=result.receipt,
            observation=result.observation,
        )

    def execute_plan(self, state: State, plan: Plan) -> PlanExecutionResult:
        validation = validate_plan(plan, state, self._registry)
        if not validation.valid:
            return PlanExecutionResult(
                status=PlanExecutionStatus.REJECTED,
                final_state=state,
                error="; ".join(validation.issues),
            )

        order = topological_order(plan)
        task_by_id = {task.task_id: task for task in plan.tasks}
        current = state
        results: list[TransitionResult] = []

        for task_id in order:
            transition = self.apply_task(current, task_by_id[task_id])
            results.append(transition)
            if transition.status != TransitionStatus.APPLIED:
                return PlanExecutionResult(
                    status=PlanExecutionStatus.FAILED,
                    final_state=current,
                    results=results,
                    error=f"{task_id}: {transition.status.value}",
                )
            current = transition.next_state

        return PlanExecutionResult(
            status=PlanExecutionStatus.COMPLETED,
            final_state=current,
            results=results,
        )

    def _reject(
        self,
        state: State,
        task: Task,
        status: TransitionStatus,
        *,
        error: str | None,
    ) -> TransitionResult:
        return TransitionResult(
            previous_state=state,
            next_state=None,
            task_id=task.task_id,
            capability_id=task.capability_id,
            status=status,
            error=error,
        )

    def _raw_output(self, result: CapabilityResult) -> Any:
        if result.classification == Classification.PURE:
            return result.knowledge
        if result.capability_id == CapabilityId.MUTATE:
            return result.receipt
        return result.observation

    def _project(self, state: State, task: Task, result: CapabilityResult) -> State:
        if result.classification == Classification.PURE:
            knowledge = self._merge_knowledge(state.knowledge, result.knowledge)
            observed = state.observed
        elif result.capability_id == CapabilityId.MUTATE:
            knowledge = state.knowledge
            observed = self._with_receipt(state.observed, result.receipt)
        else:
            knowledge = state.knowledge
            observed = self._with_observation(state.observed, result.observation)

        context = ExecutionContext(
            run_id=state.context.run_id,
            goal_ref=state.context.goal_ref,
            plan_ref=state.context.plan_ref,
            trace=[*state.context.trace, task.task_id],
        )
        return State(knowledge=knowledge, observed=observed, context=context)

    @staticmethod
    def _merge_knowledge(
        current: KnowledgeState, delta: KnowledgeState
    ) -> KnowledgeState:
        return KnowledgeState(entries={**current.entries, **delta.entries})

    @staticmethod
    def _with_receipt(observed: ObservedWorldState, receipt) -> ObservedWorldState:
        receipts = {**observed.receipts, receipt.receipt_id: receipt}
        return ObservedWorldState(
            observations=observed.observations,
            receipts=receipts,
        )

    @staticmethod
    def _with_observation(
        observed: ObservedWorldState, observation
    ) -> ObservedWorldState:
        observations = {
            **observed.observations,
            observation.observation_id: observation,
        }
        return ObservedWorldState(
            observations=observations,
            receipts=observed.receipts,
        )


__all__ = ["TransitionEngine"]
