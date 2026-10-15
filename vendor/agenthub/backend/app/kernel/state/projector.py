from __future__ import annotations

from app.kernel.artifact.model import Artifact, ArtifactRef
from app.kernel.artifact.store import ArtifactStore
from app.kernel.state.model import (
    ExecutionContext,
    KnowledgeState,
    ObservedWorldState,
    State,
)


class StateProjector:
    """从 ArtifactStore 中投影出 State。

    State 是 ArtifactStore 的引用视图，而不是 ArtifactStore 本身；
    State 只保存 ArtifactRef，payload 永远留在 store。
    """

    def __init__(self, artifact_store: ArtifactStore) -> None:
        self._artifact_store = artifact_store

    def project(
        self,
        *,
        context: ExecutionContext,
        knowledge: KnowledgeState,
        observed: ObservedWorldState,
    ) -> State:
        for entry in knowledge.entries.values():
            for ref in entry.artifact_refs:
                self._resolve(ref)
        return State(knowledge=knowledge, observed=observed, context=context)

    def materialize(self, ref: ArtifactRef) -> Artifact:
        return self._resolve(ref)

    def _resolve(self, ref: ArtifactRef) -> Artifact:
        artifact = self._artifact_store.get(ref.artifact_id)
        if artifact is None or artifact.content_hash != ref.content_hash:
            raise ValueError(f"artifact reference does not resolve: {ref.artifact_id}")
        return artifact


__all__ = ["StateProjector"]
