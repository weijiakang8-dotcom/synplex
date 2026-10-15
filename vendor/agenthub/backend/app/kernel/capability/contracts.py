from __future__ import annotations

import hashlib
from typing import Any

from app.kernel.artifact.model import Artifact
from app.kernel.artifact.store import ArtifactStore
from app.kernel.capability.model import (
    CapabilityDefinition,
    CapabilityId,
    Classification,
    Predicate,
    SideEffectPolicy,
)
from app.kernel.capability.registry import CapabilityRegistry
from app.kernel.effects.command import Command
from app.kernel.effects.receipt import ExecutionReceipt, ReceiptStatus
from app.kernel.evidence.model import EvidenceLevel
from app.kernel.state.model import (
    KnowledgeEntry,
    KnowledgeKind,
    KnowledgeState,
    Observation,
)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _p(name: str, **params: Any) -> Predicate:
    return Predicate(name=name, params=params)


def _retrieve(state, args, store: ArtifactStore) -> KnowledgeState:
    ref = store.get_ref(args["artifact_id"])
    entry = KnowledgeEntry(
        id=f"retrieved:{ref.artifact_id}",
        kind=KnowledgeKind.CANDIDATE_ARTIFACT,
        statement="retrieved artifact",
        evidence_level=ref.evidence_level,
        artifact_refs=[ref],
    )
    return KnowledgeState(entries={entry.id: entry})


def _extract(state, args, store: ArtifactStore) -> KnowledgeState:
    ref = store.get_ref(args["source_artifact_id"])
    entries = [
        KnowledgeEntry(
            id=f"fact:{_digest(fact)}:{ref.artifact_id}",
            kind=KnowledgeKind.FACT,
            statement=fact,
            evidence_level=EvidenceLevel.L2_SUPPORTED,
            artifact_refs=[ref],
        )
        for fact in args.get("facts", [])
    ]
    return KnowledgeState(entries={entry.id: entry for entry in entries})


def _compute(state, args, store: ArtifactStore) -> KnowledgeState:
    operation = args.get("operation", "compute")
    inputs = sorted(args.get("inputs", []))
    content = f"compute:{operation}:{inputs}".encode()
    artifact = Artifact.create(
        artifact_id=f"computed:{_digest(content.decode('utf-8'))}",
        artifact_type="computation",
        content=content,
        evidence_level=EvidenceLevel.L2_SUPPORTED,
        producer="compute",
    )
    ref = store.put(artifact)
    entry = KnowledgeEntry(
        id=f"derived:{ref.artifact_id}",
        kind=KnowledgeKind.DERIVED_ARTIFACT,
        statement=f"computed {operation}",
        evidence_level=EvidenceLevel.L2_SUPPORTED,
        artifact_refs=[ref],
    )
    return KnowledgeState(entries={entry.id: entry})


def _validate(state, args, store: ArtifactStore) -> KnowledgeState:
    ref = store.get_ref(args["candidate_artifact_id"])
    valid = bool(args.get("rule"))
    entry = KnowledgeEntry(
        id=f"validation:{ref.artifact_id}",
        kind=KnowledgeKind.FACT,
        statement="validated" if valid else "rejected",
        evidence_level=EvidenceLevel.L2_SUPPORTED,
        artifact_refs=[ref],
    )
    return KnowledgeState(entries={entry.id: entry})


def _reason(state, args, store: ArtifactStore) -> KnowledgeState:
    premises = sorted(args.get("premises", []))
    statement = "hypothesis from premises: " + ", ".join(premises)
    entry = KnowledgeEntry(
        id=f"hypothesis:{_digest(statement)}",
        kind=KnowledgeKind.HYPOTHESIS,
        statement=statement,
        evidence_level=EvidenceLevel.L1_INFERRED,
    )
    return KnowledgeState(entries={entry.id: entry})


def _synthesize(state, args, store: ArtifactStore) -> KnowledgeState:
    parts = sorted(args.get("parts", []))
    content = ("synthesis:" + "|".join(parts)).encode("utf-8")
    artifact = Artifact.create(
        artifact_id=f"synthesis:{_digest(content.decode('utf-8'))}",
        artifact_type="synthesis",
        content=content,
        evidence_level=EvidenceLevel.L2_SUPPORTED,
        producer="synthesize",
    )
    ref = store.put(artifact)
    entry = KnowledgeEntry(
        id=f"derived:{ref.artifact_id}",
        kind=KnowledgeKind.DERIVED_ARTIFACT,
        statement="synthesized artifact",
        evidence_level=EvidenceLevel.L2_SUPPORTED,
        artifact_refs=[ref],
    )
    return KnowledgeState(entries={entry.id: entry})


def _observe(state, args, store: ArtifactStore) -> Observation:
    command: Command = args["command"]
    return Observation(
        observation_id=f"observation:{command.command_id}",
        source="deterministic-simulator",
        observed_at="",
        external_state={
            "capability_id": command.capability_id,
            "status": "confirmed",
        },
        evidence_level=EvidenceLevel.L3_OBSERVED,
    )


def _mutate(state, args, store: ArtifactStore) -> ExecutionReceipt:
    command: Command = args["command"]
    return ExecutionReceipt(
        receipt_id=f"receipt:{command.command_id}",
        command_id=command.command_id,
        idempotency_key=command.idempotency_key,
        status=ReceiptStatus.SUCCESS,
        attempted_at=0,
        completed_at=0,
    )


STANDARD_DEFINITIONS: list[CapabilityDefinition] = [
    CapabilityDefinition(
        capability_id=CapabilityId.RETRIEVE,
        classification=Classification.PURE,
        input_contract={"artifact_id": "str"},
        output_contract={"kind": "candidate_artifact"},
        preconditions=[_p("required_artifact_exists", arg="artifact_id")],
        side_effect_policy=SideEffectPolicy.NONE,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.EXTRACT,
        classification=Classification.PURE,
        input_contract={"source_artifact_id": "str", "facts": "list[str]"},
        output_contract={"kind": "facts"},
        preconditions=[_p("required_artifact_exists", arg="source_artifact_id")],
        side_effect_policy=SideEffectPolicy.NONE,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.COMPUTE,
        classification=Classification.PURE,
        input_contract={"operation": "str", "inputs": "list[str]"},
        output_contract={"kind": "derived_artifact"},
        postconditions=[_p("artifact_created", artifact_type="computation")],
        side_effect_policy=SideEffectPolicy.NONE,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.VALIDATE,
        classification=Classification.PURE,
        input_contract={"candidate_artifact_id": "str", "rule": "str"},
        output_contract={"kind": "fact"},
        preconditions=[_p("required_artifact_exists", arg="candidate_artifact_id")],
        side_effect_policy=SideEffectPolicy.NONE,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.REASON,
        classification=Classification.PURE,
        input_contract={"premises": "list[str]"},
        output_contract={"kind": "hypothesis"},
        side_effect_policy=SideEffectPolicy.NONE,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.SYNTHESIZE,
        classification=Classification.PURE,
        input_contract={"parts": "list[str]"},
        output_contract={"kind": "derived_artifact"},
        postconditions=[_p("artifact_created", artifact_type="synthesis")],
        side_effect_policy=SideEffectPolicy.NONE,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.OBSERVE,
        classification=Classification.EFFECTFUL,
        input_contract={"command": "Command"},
        output_contract={"kind": "observation"},
        preconditions=[_p("required_command")],
        postconditions=[_p("output_is_observation")],
        side_effect_policy=SideEffectPolicy.OBSERVATION_REQUIRED,
    ),
    CapabilityDefinition(
        capability_id=CapabilityId.MUTATE,
        classification=Classification.EFFECTFUL,
        input_contract={"command": "Command"},
        output_contract={"kind": "receipt"},
        preconditions=[_p("required_command")],
        postconditions=[_p("output_is_receipt")],
        side_effect_policy=SideEffectPolicy.COMMAND_REQUIRED,
    ),
]


STANDARD_IMPLEMENTATIONS: dict[CapabilityId, Any] = {
    CapabilityId.RETRIEVE: _retrieve,
    CapabilityId.EXTRACT: _extract,
    CapabilityId.COMPUTE: _compute,
    CapabilityId.VALIDATE: _validate,
    CapabilityId.REASON: _reason,
    CapabilityId.SYNTHESIZE: _synthesize,
    CapabilityId.OBSERVE: _observe,
    CapabilityId.MUTATE: _mutate,
}


def build_standard_registry() -> CapabilityRegistry:
    registry = CapabilityRegistry()
    for definition in STANDARD_DEFINITIONS:
        registry.register(
            definition,
            STANDARD_IMPLEMENTATIONS[definition.capability_id],
        )
    return registry


__all__ = [
    "STANDARD_DEFINITIONS",
    "STANDARD_IMPLEMENTATIONS",
    "build_standard_registry",
]
