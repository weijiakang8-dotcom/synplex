from __future__ import annotations

from app.kernel.artifact.store import ArtifactStore
from app.kernel.evidence.model import (
    EvidenceLevel,
    max_evidence_level,
    satisfies_required_evidence,
)
from app.kernel.goal.errors import UnknownConstraintError, UnknownGoalPredicateError
from app.kernel.goal.model import Constraint, Goal, GoalPredicate
from app.kernel.goal.result import GoalEvaluationResult, GoalStatus
from app.kernel.state.model import State

KNOWN_GOAL_PREDICATES: frozenset[str] = frozenset(
    {
        "always_true",
        "always_false",
        "knowledge_entry_exists",
        "observation_exists",
        "observation_committed_equals",
        "observation_status_equals",
        "receipt_exists",
        "receipt_status_equals",
        "artifact_exists",
        "artifact_type_exists",
        "evidence_at_least",
    }
)

KNOWN_CONSTRAINTS: frozenset[str] = frozenset({"always_true", "always_false"})


def evaluate_goal_predicate(
    predicate: GoalPredicate,
    *,
    state: State,
    artifact_store: ArtifactStore | None = None,
) -> bool:
    name = predicate.name
    params = predicate.params or {}

    if name == "always_true":
        return True
    if name == "always_false":
        return False

    if name == "knowledge_entry_exists":
        kind = params.get("kind")
        for entry in state.knowledge.entries.values():
            if kind is None or entry.kind.value == kind:
                return True
        return False

    if name == "observation_exists":
        return bool(state.observed.observations)

    if name == "observation_committed_equals":
        value = params.get("value")
        return any(
            observation.external_state.get("committed") == value
            for observation in state.observed.observations.values()
        )

    if name == "observation_status_equals":
        status = params.get("status")
        return any(
            observation.external_state.get("status") == status
            for observation in state.observed.observations.values()
        )

    if name == "receipt_exists":
        return bool(state.observed.receipts)

    if name == "receipt_status_equals":
        status = params.get("status")
        return any(
            receipt.status.value == status
            for receipt in state.observed.receipts.values()
        )

    if name == "artifact_exists":
        return artifact_store is not None and artifact_store.has(params["artifact_id"])

    if name == "artifact_type_exists":
        if artifact_store is None:
            return False
        artifact_type = params["artifact_type"]
        return any(
            artifact_store.get(artifact_id).artifact_type == artifact_type
            for artifact_id in artifact_store.ids()
        )

    if name == "evidence_at_least":
        required = EvidenceLevel(params["level"])
        actual = max_evidence_level(_evidence_levels(state))
        return satisfies_required_evidence(actual, required)

    raise UnknownGoalPredicateError(f"unknown goal predicate: {name}")


def evaluate_constraint(
    constraint: Constraint,
    *,
    state: State,
    artifact_store: ArtifactStore | None = None,
) -> bool:
    if constraint.name == "always_true":
        return True
    if constraint.name == "always_false":
        return False
    raise UnknownConstraintError(f"unknown constraint: {constraint.name}")


def _evidence_levels(state: State) -> list[EvidenceLevel]:
    levels = [entry.evidence_level for entry in state.knowledge.entries.values()]
    levels += [
        observation.evidence_level
        for observation in state.observed.observations.values()
    ]
    return levels


def _validate_evidence(state: State) -> bool:
    for entry in state.knowledge.entries.values():
        if entry.evidence_level in (
            EvidenceLevel.L3_OBSERVED,
            EvidenceLevel.L4_ATTESTED,
        ):
            return False
    for observation in state.observed.observations.values():
        if observation.evidence_level in (
            EvidenceLevel.L1_INFERRED,
            EvidenceLevel.L2_SUPPORTED,
        ):
            return False
    return True


class GoalEvaluator:
    """判断 Goal 是否 SATISFIED 的唯一确定性入口。"""

    def evaluate(
        self,
        state: State,
        goal: Goal,
        artifact_store: ArtifactStore | None = None,
    ) -> GoalEvaluationResult:
        store = artifact_store or ArtifactStore()
        predicate_result = evaluate_goal_predicate(
            goal.predicate,
            state=state,
            artifact_store=store,
        )

        evidence_ok, evidence_result, actual = self._evidence_gate(
            state,
            goal.required_evidence,
        )
        constraint_result = all(
            evaluate_constraint(constraint, state=state, artifact_store=store)
            for constraint in goal.constraints
            if constraint.hard
        )

        satisfied = predicate_result and evidence_ok and constraint_result
        status = GoalStatus.SATISFIED if satisfied else GoalStatus.NOT_SATISFIED
        reasons = {
            "predicate": "TRUE" if predicate_result else "FALSE",
            "evidence": evidence_result,
            "required": goal.required_evidence.value,
            "actual": actual.value if actual is not None else "INVALID",
            "constraints": "SATISFIED" if constraint_result else "FAILED",
        }

        return GoalEvaluationResult(
            status=status,
            goal_id=goal.goal_id,
            predicate_result=predicate_result,
            evidence_result=evidence_result,
            constraint_result=constraint_result,
            reasons=reasons,
        )

    @staticmethod
    def _evidence_gate(
        state: State,
        required: EvidenceLevel,
    ) -> tuple[bool, str, EvidenceLevel | None]:
        if not _validate_evidence(state):
            return False, "INVALID", None
        actual = max_evidence_level(_evidence_levels(state))
        ok = satisfies_required_evidence(actual, required)
        return ok, ("SUFFICIENT" if ok else "INSUFFICIENT"), actual


__all__ = [
    "KNOWN_CONSTRAINTS",
    "KNOWN_GOAL_PREDICATES",
    "GoalEvaluator",
    "evaluate_constraint",
    "evaluate_goal_predicate",
]
