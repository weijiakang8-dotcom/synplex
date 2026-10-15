from __future__ import annotations

import hashlib
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.evidence.model import EvidenceLevel


class Artifact(BaseModel):
    """内容寻址的产物。payload 只存在于 ArtifactStore，State 只持有 ArtifactRef。"""

    model_config = ConfigDict(frozen=True)

    artifact_id: str
    artifact_type: str
    content: bytes
    content_hash: str
    evidence_level: EvidenceLevel
    producer: str
    metadata: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def create(
        cls,
        *,
        artifact_id: str,
        artifact_type: str,
        content: bytes,
        evidence_level: EvidenceLevel,
        producer: str,
        metadata: dict[str, Any] | None = None,
    ) -> Artifact:
        return cls(
            artifact_id=artifact_id,
            artifact_type=artifact_type,
            content=content,
            content_hash=hashlib.sha256(content).hexdigest(),
            evidence_level=evidence_level,
            producer=producer,
            metadata=metadata or {},
        )

    def ref(self) -> ArtifactRef:
        return ArtifactRef(
            artifact_id=self.artifact_id,
            artifact_type=self.artifact_type,
            content_hash=self.content_hash,
            evidence_level=self.evidence_level,
        )


class ArtifactRef(BaseModel):
    """State 中保存的产物引用，不含 payload。"""

    model_config = ConfigDict(frozen=True)

    artifact_id: str
    artifact_type: str
    content_hash: str
    evidence_level: EvidenceLevel


__all__ = ["Artifact", "ArtifactRef"]
