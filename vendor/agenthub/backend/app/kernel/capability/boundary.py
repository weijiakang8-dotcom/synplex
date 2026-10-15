from __future__ import annotations

from typing import Any

from app.kernel.capability.errors import InvalidCapabilityContractError
from app.kernel.capability.model import (
    CapabilityDefinition,
    CapabilityId,
    CapabilityOutcome,
    CapabilityResult,
    Classification,
)
from app.kernel.capability.predicates import evaluate_predicate
from app.kernel.capability.registry import CapabilityRegistry
from app.kernel.state.model import (
    ExecutionReceipt,
    KnowledgeState,
    Observation,
)


class CapabilityBoundary:
    """Capability 的最小执行边界。

    只做：解析 -> Precondition -> Apply -> Postcondition -> 类型化打包。
    这不是 TransitionEngine（Phase 2.2），不做 State Graph / Goal / Replan。
    """

    def __init__(self, registry: CapabilityRegistry) -> None:
        self._registry = registry

    def apply(
        self,
        capability_id: CapabilityId,
        *,
        state,
        args: dict[str, Any],
        artifact_store,
    ) -> CapabilityResult:
        definition, implementation = self._registry.resolve(capability_id)

        for predicate in definition.preconditions:
            if not evaluate_predicate(
                predicate,
                state=state,
                artifact_store=artifact_store,
                args=args,
                output=None,
            ):
                return self._failure(definition, CapabilityOutcome.PRECONDITION_FAILED)

        output = implementation(state, args, artifact_store)

        for predicate in definition.postconditions:
            if not evaluate_predicate(
                predicate,
                state=state,
                artifact_store=artifact_store,
                args=args,
                output=output,
            ):
                return self._failure(definition, CapabilityOutcome.POSTCONDITION_FAILED)

        return self._package(definition, args, output)

    def _failure(
        self,
        definition: CapabilityDefinition,
        outcome: CapabilityOutcome,
    ) -> CapabilityResult:
        return CapabilityResult(
            capability_id=definition.capability_id,
            classification=definition.classification,
            outcome=outcome,
        )

    def _package(
        self,
        definition: CapabilityDefinition,
        args: dict[str, Any],
        output: Any,
    ) -> CapabilityResult:
        if definition.classification == Classification.PURE:
            if not isinstance(output, KnowledgeState):
                raise InvalidCapabilityContractError(
                    f"{definition.capability_id.value} must return KnowledgeState"
                )
            return CapabilityResult(
                capability_id=definition.capability_id,
                classification=Classification.PURE,
                outcome=CapabilityOutcome.APPLIED,
                knowledge=output,
            )

        if definition.capability_id == CapabilityId.MUTATE:
            if not isinstance(output, ExecutionReceipt):
                raise InvalidCapabilityContractError(
                    "mutate must return ExecutionReceipt"
                )
            return CapabilityResult(
                capability_id=definition.capability_id,
                classification=Classification.EFFECTFUL,
                outcome=CapabilityOutcome.APPLIED,
                command=args.get("command"),
                receipt=output,
            )

        if definition.capability_id == CapabilityId.OBSERVE:
            if not isinstance(output, Observation):
                raise InvalidCapabilityContractError("observe must return Observation")
            return CapabilityResult(
                capability_id=definition.capability_id,
                classification=Classification.EFFECTFUL,
                outcome=CapabilityOutcome.APPLIED,
                observation=output,
            )

        raise InvalidCapabilityContractError(
            f"unhandled capability classification: {definition.capability_id.value}"
        )


__all__ = ["CapabilityBoundary"]
