from __future__ import annotations

import hashlib

from app.kernel.artifact.model import Artifact, ArtifactRef


class ArtifactStore:
    """内存态产物存储，Phase 2 不持久化。"""

    def __init__(self) -> None:
        self._artifacts: dict[str, Artifact] = {}

    def put(self, artifact: Artifact) -> ArtifactRef:
        if artifact.content_hash != hashlib.sha256(artifact.content).hexdigest():
            raise ValueError(
                f"artifact content_hash mismatch for {artifact.artifact_id}"
            )
        self._artifacts[artifact.artifact_id] = artifact
        return artifact.ref()

    def get(self, artifact_id: str) -> Artifact | None:
        return self._artifacts.get(artifact_id)

    def get_ref(self, artifact_id: str) -> ArtifactRef | None:
        artifact = self._artifacts.get(artifact_id)
        return artifact.ref() if artifact is not None else None

    def has(self, artifact_id: str) -> bool:
        return artifact_id in self._artifacts

    def ids(self) -> list[str]:
        return sorted(self._artifacts.keys())

    def get_by_content_hash(self, content_hash: str) -> Artifact | None:
        for artifact in self._artifacts.values():
            if artifact.content_hash == content_hash:
                return artifact
        return None


__all__ = ["ArtifactStore"]
