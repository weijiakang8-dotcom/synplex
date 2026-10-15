from __future__ import annotations

import hashlib
import json

from app.adapters.capability_mapping import classify_legacy_tool
from app.adapters.errors import InvalidLegacyToolError
from app.adapters.legacy_models import LegacyExecution
from app.kernel.artifact.model import Artifact
from app.kernel.artifact.store import ArtifactStore
from app.kernel.capability.model import CapabilityId
from app.kernel.capability.registry import CapabilityRegistry
from app.kernel.evidence.model import EvidenceLevel
from app.kernel.goal.model import Goal, GoalPredicate
from app.kernel.plan.model import Plan
from app.kernel.runtime.model import RuntimeInput
from app.kernel.state.model import (
    ExecutionContext,
    KnowledgeEntry,
    KnowledgeKind,
    KnowledgeState,
    State,
)
from app.kernel.task.model import Task

SOURCE_ARTIFACT_ID = "legacy_query"
FINAL_OUTPUT_ARTIFACT_ID = "legacy_final_output"
QUERY_RESULT_ARTIFACT_PREFIX = "legacy_query_result"


class LegacyExecutionAdapter:
    """Legacy Execution 数据 → Kernel 契约的显式转换。"""

    def build_artifact_store(self, legacy: LegacyExecution) -> ArtifactStore:
        store = ArtifactStore()
        store.put(
            Artifact.create(
                artifact_id=SOURCE_ARTIFACT_ID,
                artifact_type="legacy/query",
                content=legacy.user_input.encode("utf-8"),
                evidence_level=EvidenceLevel.L2_SUPPORTED,
                producer="legacy-adapter",
            )
        )
        if legacy.final_output:
            store.put(
                Artifact.create(
                    artifact_id=FINAL_OUTPUT_ARTIFACT_ID,
                    artifact_type="legacy/final_output",
                    content=legacy.final_output.encode("utf-8"),
                    evidence_level=EvidenceLevel.L1_INFERRED,
                    producer="legacy-adapter",
                )
            )

        for tool_call in legacy.tool_calls:
            mapping = classify_legacy_tool(tool_call.tool_name, tool_call.input_params)
            if mapping is not None and mapping.tool_name == "query_db_internal":
                store.put(
                    Artifact.create(
                        artifact_id=f"{QUERY_RESULT_ARTIFACT_PREFIX}:{tool_call.tool_name}",
                        artifact_type="legacy/query_result",
                        content=json.dumps(
                            tool_call.output_result or {},
                            default=str,
                        ).encode("utf-8"),
                        evidence_level=EvidenceLevel.L2_SUPPORTED,
                        producer="legacy-adapter",
                    )
                )
        return store

    def to_knowledge_state(
        self,
        legacy: LegacyExecution,
        store: ArtifactStore,
    ) -> KnowledgeState:
        """Legacy 数据 → KnowledgeState（绝不进入 ObservedWorldState）。"""
        entries: dict[str, KnowledgeEntry] = {}
        source_ref = store.get_ref(SOURCE_ARTIFACT_ID)

        for tool_call in legacy.tool_calls:
            mapping = classify_legacy_tool(tool_call.tool_name, tool_call.input_params)
            if mapping is None or mapping.classification == "EFFECTFUL":
                continue
            if tool_call.tool_name.strip().lower() == "query_db":
                artifact_ref = store.get_ref(
                    f"{QUERY_RESULT_ARTIFACT_PREFIX}:{tool_call.tool_name}"
                )
                statement = "query_db internal result"
            else:
                artifact_ref = source_ref
                statement = f"{tool_call.tool_name} result"
            entries[f"fact:{tool_call.tool_name}"] = KnowledgeEntry(
                id=f"fact:{tool_call.tool_name}",
                kind=KnowledgeKind.FACT,
                statement=statement,
                evidence_level=EvidenceLevel.L2_SUPPORTED,
                artifact_refs=[artifact_ref] if artifact_ref else [],
            )

        if legacy.final_output:
            final_ref = store.get_ref(FINAL_OUTPUT_ARTIFACT_ID)
            entries["derived:final_output"] = KnowledgeEntry(
                id="derived:final_output",
                kind=KnowledgeKind.DERIVED_ARTIFACT,
                statement=legacy.final_output,
                evidence_level=EvidenceLevel.L1_INFERRED,
                artifact_refs=[final_ref] if final_ref else [],
            )

        return KnowledgeState(entries=entries)

    def to_plan(self, legacy: LegacyExecution) -> Plan:
        send_email = self._send_email_call(legacy)
        if send_email is not None:
            payload = self._send_email_payload(send_email)
            if payload is None:
                raise InvalidLegacyToolError(
                    "send_email missing required fields (to/subject/body)"
                )
            key = self._send_email_idempotency_key(payload)
            outcome = str(send_email.input_params.get("world_outcome", "SUCCESS"))
            tasks = [
                Task(
                    task_id="t_mutate_email",
                    capability_id=CapabilityId.MUTATE,
                    input_arguments={
                        "idempotency_key": key,
                        "world_outcome": outcome,
                        "payload": payload,
                    },
                ),
                Task(
                    task_id="t_observe_email",
                    capability_id=CapabilityId.OBSERVE,
                    input_arguments={
                        "idempotency_key": key,
                        "world_outcome": "SUCCESS",
                    },
                ),
            ]
            return Plan(plan_id=f"legacy:{legacy.execution_id}", tasks=tasks)

        external = self._external_query_db(legacy)
        if external is not None:
            key = str(
                external.input_params.get(
                    "idempotency_key",
                    f"query_db_external:{legacy.execution_id}",
                )
            )
            outcome = str(external.input_params.get("world_outcome", "SUCCESS"))
            tasks = [
                Task(
                    task_id="t_observe_external",
                    capability_id=CapabilityId.OBSERVE,
                    input_arguments={"idempotency_key": key, "world_outcome": outcome},
                )
            ]
        else:
            tasks = [
                Task(
                    task_id="t_retrieve",
                    capability_id=CapabilityId.RETRIEVE,
                    input_artifacts=[SOURCE_ARTIFACT_ID],
                    input_arguments={"artifact_id": SOURCE_ARTIFACT_ID},
                )
            ]
        return Plan(plan_id=f"legacy:{legacy.execution_id}", tasks=tasks)

    def to_goal(
        self,
        required_evidence: EvidenceLevel = EvidenceLevel.L2_SUPPORTED,
    ) -> Goal:
        return Goal(
            goal_id="legacy_retrieve_goal",
            predicate=GoalPredicate(
                name="knowledge_entry_exists",
                params={"kind": "CANDIDATE_ARTIFACT"},
            ),
            required_evidence=required_evidence,
        )

    def to_goal_for_legacy(
        self,
        legacy: LegacyExecution,
        required_evidence: EvidenceLevel | None = None,
    ) -> Goal:
        if (
            self._external_query_db(legacy) is not None
            or self._send_email_call(legacy) is not None
        ):
            return Goal(
                goal_id="legacy_effectful_observe_goal",
                predicate=GoalPredicate(name="observation_exists"),
                required_evidence=required_evidence or EvidenceLevel.L3_OBSERVED,
            )
        return self.to_goal(
            required_evidence=required_evidence or EvidenceLevel.L2_SUPPORTED
        )

    def to_runtime_input(
        self,
        legacy: LegacyExecution,
        *,
        registry: CapabilityRegistry,
        store: ArtifactStore,
        executor,
        goal: Goal | None = None,
    ) -> RuntimeInput:
        return RuntimeInput(
            initial_state=State(context=ExecutionContext(run_id=legacy.execution_id)),
            plan=self.to_plan(legacy),
            goal=goal or self.to_goal_for_legacy(legacy),
            capability_registry=registry,
            artifact_store=store,
            effect_port=executor,
        )

    @staticmethod
    def _external_query_db(legacy: LegacyExecution):
        for tool_call in legacy.tool_calls:
            mapping = classify_legacy_tool(tool_call.tool_name, tool_call.input_params)
            if mapping is not None and mapping.tool_name == "query_db_external":
                return tool_call
        return None

    @staticmethod
    def _send_email_call(legacy: LegacyExecution):
        for tool_call in legacy.tool_calls:
            mapping = classify_legacy_tool(tool_call.tool_name, tool_call.input_params)
            if mapping is not None and mapping.tool_name == "send_email":
                return tool_call
        return None

    @staticmethod
    def _send_email_payload(tool_call) -> dict | None:
        recipient = tool_call.input_params.get("to") or tool_call.input_params.get(
            "recipient"
        )
        subject = tool_call.input_params.get("subject")
        body = tool_call.input_params.get("body") or tool_call.input_params.get(
            "message"
        )
        if not recipient or not subject or not body:
            return None
        return {"to": recipient, "subject": subject, "body": body}

    @staticmethod
    def _send_email_idempotency_key(payload: dict) -> str:
        subject_hash = hashlib.sha256(payload["subject"].encode("utf-8")).hexdigest()[
            :16
        ]
        body_hash = hashlib.sha256(payload["body"].encode("utf-8")).hexdigest()[:16]
        return f"email:{payload['to']}:{subject_hash}:{body_hash}"


__all__ = [
    "FINAL_OUTPUT_ARTIFACT_ID",
    "QUERY_RESULT_ARTIFACT_PREFIX",
    "SOURCE_ARTIFACT_ID",
    "LegacyExecutionAdapter",
]
