from __future__ import annotations

from typing import Any

from app.kernel.capability.errors import UnknownPredicateError
from app.kernel.capability.model import Predicate
from app.kernel.effects.command import Command
from app.kernel.state.model import (
    ExecutionReceipt,
    KnowledgeState,
    Observation,
)

KNOWN_PREDICATES: frozenset[str] = frozenset(
    {
        "required_artifact_exists",
        "required_command",
        "artifact_created",
        "output_is_receipt",
        "output_is_observation",
    }
)


def is_known_predicate(name: str) -> bool:
    return name in KNOWN_PREDICATES


def evaluate_predicate(
    predicate: Predicate,
    *,
    state,
    artifact_store,
    args: dict[str, Any],
    output: Any,
) -> bool:
    """确定性、无副作用地求值一个 Predicate。"""
    name = predicate.name
    params = predicate.params or {}

    if name == "required_artifact_exists":
        arg_name = params["arg"]
        return artifact_store.has(args.get(arg_name))

    if name == "required_command":
        return isinstance(args.get("command"), Command)

    if name == "artifact_created":
        artifact_type = params.get("artifact_type")
        if not isinstance(output, KnowledgeState):
            return False
        for entry in output.entries.values():
            for ref in entry.artifact_refs:
                if ref.artifact_type == artifact_type and artifact_store.has(
                    ref.artifact_id
                ):
                    return True
        return False

    if name == "output_is_receipt":
        return isinstance(output, ExecutionReceipt)

    if name == "output_is_observation":
        return isinstance(output, Observation)

    raise UnknownPredicateError(f"unknown predicate: {name}")


__all__ = ["KNOWN_PREDICATES", "evaluate_predicate", "is_known_predicate"]
