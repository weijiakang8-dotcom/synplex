from __future__ import annotations

from dataclasses import dataclass, field

from app.kernel.capability.classification import Classification, classify
from app.kernel.capability.model import CapabilityId
from app.kernel.effects.command import Command
from app.kernel.effects.receipt import ExecutionReceipt, ReceiptStatus
from app.kernel.effects.reconciliation import ReconciliationResult
from app.kernel.evidence.model import EvidenceLevel, max_evidence_level
from app.kernel.goal.evaluator import GoalEvaluator
from app.kernel.goal.model import Goal
from app.kernel.goal.result import GoalStatus
from app.kernel.plan.validator import topological_order, validate_plan
from app.kernel.runtime.model import RuntimeInput, TerminationReason
from app.kernel.runtime.result import (
    EffectHistoryEntry,
    RuntimeOutput,
    RuntimeTraceEntry,
)
from app.kernel.state.model import (
    ExecutionContext,
    Observation,
    ObservedWorldState,
    State,
)
from app.kernel.task.model import Task
from app.kernel.transition.engine import TransitionEngine
from app.kernel.transition.model import TransitionStatus


@dataclass
class _EffectStep:
    state: State
    trace: list[RuntimeTraceEntry] = field(default_factory=list)
    effect_history: list[EffectHistoryEntry] = field(default_factory=list)
    termination: TerminationReason | None = None
    reason: str | None = None


class KernelRuntime:
    """协调 PlanValidation / TransitionEngine / EffectLifecycle / GoalEvaluator。"""

    def __init__(self) -> None:
        self._goal_evaluator = GoalEvaluator()

    def run(self, runtime_input: RuntimeInput) -> RuntimeOutput:
        state = runtime_input.initial_state
        artifact_store = runtime_input.artifact_store

        validation = validate_plan(
            runtime_input.plan,
            state,
            runtime_input.capability_registry,
        )
        if not validation.valid:
            return self._terminate(
                state,
                runtime_input.goal,
                artifact_store,
                TerminationReason.TERMINATED_ERROR,
                error="; ".join(validation.issues),
            )

        order = topological_order(runtime_input.plan)
        task_by_id = {task.task_id: task for task in runtime_input.plan.tasks}
        transition_engine = TransitionEngine(
            runtime_input.capability_registry,
            artifact_store,
        )

        goal_result = self._goal_evaluator.evaluate(
            state, runtime_input.goal, artifact_store
        )
        if goal_result.status == GoalStatus.SATISFIED:
            return self._terminate(
                state,
                runtime_input.goal,
                artifact_store,
                TerminationReason.TERMINATED_GOAL_SATISFIED,
                goal_result=goal_result,
            )

        trace: list[RuntimeTraceEntry] = []
        effect_history: list[EffectHistoryEntry] = []
        applied_tasks: list[str] = []
        step_index = 0
        task_index = 0

        while task_index < len(order):
            if step_index >= runtime_input.max_steps:
                return self._terminate(
                    state,
                    runtime_input.goal,
                    artifact_store,
                    TerminationReason.TERMINATED_MAX_STEPS,
                    trace=trace,
                    effect_history=effect_history,
                    applied_tasks=applied_tasks,
                    goal_result=goal_result,
                )

            task_id = order[task_index]
            task = task_by_id[task_id]
            step_index += 1

            if classify(task.capability_id) == Classification.PURE:
                evidence_before = self._evidence_of(state)
                transition = transition_engine.apply_task(state, task)
                evidence_after = (
                    self._evidence_of(transition.next_state)
                    if transition.next_state is not None
                    else evidence_before
                )
                produced = [ref.artifact_id for ref in transition.produced_artifacts]
                trace.append(
                    RuntimeTraceEntry(
                        step_index=step_index,
                        task_id=task_id,
                        capability_id=task.capability_id.value,
                        action="PURE_TRANSITION",
                        result=transition.status.value,
                        evidence_before=evidence_before,
                        evidence_after=evidence_after,
                        produced_artifacts=produced or None,
                    )
                )
                if transition.status != TransitionStatus.APPLIED:
                    return self._terminate(
                        state,
                        runtime_input.goal,
                        artifact_store,
                        TerminationReason.TERMINATED_ERROR,
                        trace=trace,
                        effect_history=effect_history,
                        applied_tasks=applied_tasks,
                        goal_result=goal_result,
                        error=f"{task_id}: {transition.status.value}",
                    )
                state = transition.next_state
                applied_tasks.append(task_id)
            else:
                effect_step = self._apply_effectful(
                    state,
                    task,
                    runtime_input.effect_port,
                    step_index,
                )
                state = effect_step.state
                trace.extend(effect_step.trace)
                effect_history.extend(effect_step.effect_history)
                applied_tasks.append(task_id)
                if effect_step.termination is not None:
                    return self._terminate(
                        state,
                        runtime_input.goal,
                        artifact_store,
                        effect_step.termination,
                        trace=trace,
                        effect_history=effect_history,
                        applied_tasks=applied_tasks,
                        goal_result=self._goal_evaluator.evaluate(
                            state, runtime_input.goal, artifact_store
                        ),
                        error=effect_step.reason,
                    )

            goal_result = self._goal_evaluator.evaluate(
                state,
                runtime_input.goal,
                artifact_store,
            )
            if goal_result.status == GoalStatus.SATISFIED:
                return self._terminate(
                    state,
                    runtime_input.goal,
                    artifact_store,
                    TerminationReason.TERMINATED_GOAL_SATISFIED,
                    trace=trace,
                    effect_history=effect_history,
                    applied_tasks=applied_tasks,
                    goal_result=goal_result,
                )

            task_index += 1

        return self._terminate(
            state,
            runtime_input.goal,
            artifact_store,
            TerminationReason.TERMINATED_NO_PATH,
            trace=trace,
            effect_history=effect_history,
            applied_tasks=applied_tasks,
            goal_result=goal_result,
        )

    def _apply_effectful(
        self,
        state: State,
        task: Task,
        effect_port,
        step_index: int,
    ) -> _EffectStep:
        trace: list[RuntimeTraceEntry] = []
        effect_history: list[EffectHistoryEntry] = []
        project_observation = task.capability_id == CapabilityId.OBSERVE
        action = "OBSERVE" if project_observation else "MUTATE"
        attempt = 0
        original = self._build_command(task, attempt)
        command = original

        while True:
            evidence_before = self._evidence_of(state)
            result = effect_port.execute_effect(command)
            committed = result.committed
            if committed is None:
                committed = effect_port.query_effect(
                    command,
                    result.external_reference,
                ).committed

            receipt = self._receipt_from_result(command, result)
            reconciliation = self._reconcile_from_committed(
                receipt.status,
                committed,
            )

            observation = None
            if project_observation and committed is True:
                observation = Observation(
                    observation_id=f"observation:{command.command_id}",
                    source="effect-port",
                    observed_at="",
                    external_state={"committed": committed},
                    evidence_level=EvidenceLevel.L3_OBSERVED,
                )

            state = self._project(
                state,
                task.task_id,
                receipt=receipt,
                observation=observation,
            )
            trace.append(
                RuntimeTraceEntry(
                    step_index=step_index,
                    task_id=task.task_id,
                    capability_id=task.capability_id.value,
                    action=action,
                    result=receipt.status.value,
                    reason=reconciliation.value,
                    evidence_before=evidence_before,
                    evidence_after=self._evidence_of(state),
                    observation_id=(
                        observation.observation_id if observation else None
                    ),
                )
            )
            effect_history.append(
                EffectHistoryEntry(
                    command_id=command.command_id,
                    idempotency_key=command.idempotency_key,
                    receipt_status=receipt.status.value,
                    reconciliation=reconciliation.value,
                )
            )

            if reconciliation in {
                ReconciliationResult.CONFIRMED_COMMITTED,
                ReconciliationResult.DUPLICATE_CONFIRMED,
            }:
                return _EffectStep(state, trace, effect_history)

            if reconciliation == ReconciliationResult.CONFIRMED_NOT_COMMITTED:
                if effect_port.can_retry(attempt):
                    attempt += 1
                    retry = effect_port.build_retry_command(original, attempt)
                    command = Command(
                        command_id=retry.command_id,
                        idempotency_key=retry.idempotency_key,
                        capability_id=retry.capability_id,
                        payload={**retry.payload, "world_outcome": "SUCCESS"},
                        created_at_logical=retry.created_at_logical,
                    )
                    continue
                return _EffectStep(
                    state,
                    trace,
                    effect_history,
                    TerminationReason.TERMINATED_RETRY_EXHAUSTED,
                    "retry exhausted",
                )

            return _EffectStep(
                state,
                trace,
                effect_history,
                TerminationReason.TERMINATED_UNKNOWN_EFFECT,
                "unknown effect",
            )

    def _receipt_from_result(
        self,
        command: Command,
        result,
    ) -> ExecutionReceipt:
        status_map = {
            "success": ReceiptStatus.SUCCESS,
            "timeout": ReceiptStatus.TIMEOUT,
            "error": ReceiptStatus.FAILED,
            "unknown": ReceiptStatus.UNKNOWN,
            "duplicate": ReceiptStatus.DUPLICATE,
        }
        return ExecutionReceipt(
            receipt_id=f"receipt:{command.command_id}",
            command_id=command.command_id,
            idempotency_key=command.idempotency_key,
            status=status_map[result.status],
            attempted_at=command.created_at_logical,
            completed_at=command.created_at_logical,
            external_reference=result.external_reference,
        )

    def _reconcile_from_committed(
        self,
        receipt_status: ReceiptStatus,
        committed: bool | None,
    ) -> ReconciliationResult:
        if committed is True:
            if receipt_status == ReceiptStatus.DUPLICATE:
                return ReconciliationResult.DUPLICATE_CONFIRMED
            return ReconciliationResult.CONFIRMED_COMMITTED
        if committed is False:
            return ReconciliationResult.CONFIRMED_NOT_COMMITTED
        return ReconciliationResult.STILL_UNKNOWN

    def _build_command(self, task: Task, attempt: int) -> Command:
        idempotency_key = task.input_arguments.get("idempotency_key")
        if not idempotency_key:
            raise ValueError(f"effectful task requires idempotency_key: {task.task_id}")
        payload = dict(task.input_arguments.get("payload", {}))
        if "world_outcome" in task.input_arguments:
            payload["world_outcome"] = task.input_arguments["world_outcome"]
        return Command(
            command_id=f"{task.task_id}:command:{attempt}",
            idempotency_key=str(idempotency_key),
            capability_id=task.capability_id.value,
            payload=payload,
            created_at_logical=attempt,
        )

    def _evidence_of(self, state: State) -> str:
        levels = [entry.evidence_level for entry in state.knowledge.entries.values()]
        levels += [
            observation.evidence_level
            for observation in state.observed.observations.values()
        ]
        return max_evidence_level(levels).value

    def _project(
        self,
        state: State,
        task_id: str,
        *,
        receipt=None,
        observation=None,
    ) -> State:
        observations = state.observed.observations
        receipts = state.observed.receipts
        if receipt is not None:
            receipts = {**receipts, receipt.receipt_id: receipt}
        if observation is not None:
            observations = {**observations, observation.observation_id: observation}
        observed = ObservedWorldState(observations=observations, receipts=receipts)
        context = ExecutionContext(
            run_id=state.context.run_id,
            goal_ref=state.context.goal_ref,
            plan_ref=state.context.plan_ref,
            trace=[*state.context.trace, task_id],
        )
        return State(knowledge=state.knowledge, observed=observed, context=context)

    def _terminate(
        self,
        state: State,
        goal: Goal,
        artifact_store,
        reason: TerminationReason,
        *,
        trace=None,
        effect_history=None,
        applied_tasks=None,
        goal_result=None,
        error: str | None = None,
    ) -> RuntimeOutput:
        return RuntimeOutput(
            final_state=state,
            goal_result=goal_result
            or self._goal_evaluator.evaluate(state, goal, artifact_store),
            execution_trace=trace or [],
            effect_history=effect_history or [],
            applied_tasks=applied_tasks or [],
            termination_reason=reason,
            error=error,
        )


__all__ = ["KernelRuntime"]
