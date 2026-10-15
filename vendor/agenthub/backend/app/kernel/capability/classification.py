from __future__ import annotations

from app.kernel.capability.model import CapabilityId, Classification

PURE_CAPABILITIES: frozenset[CapabilityId] = frozenset(
    {
        CapabilityId.RETRIEVE,
        CapabilityId.EXTRACT,
        CapabilityId.COMPUTE,
        CapabilityId.VALIDATE,
        CapabilityId.REASON,
        CapabilityId.SYNTHESIZE,
    }
)

EFFECTFUL_CAPABILITIES: frozenset[CapabilityId] = frozenset(
    {
        CapabilityId.OBSERVE,
        CapabilityId.MUTATE,
    }
)


def classify(capability_id: CapabilityId) -> Classification:
    if capability_id in PURE_CAPABILITIES:
        return Classification.PURE
    if capability_id in EFFECTFUL_CAPABILITIES:
        return Classification.EFFECTFUL
    raise ValueError(f"unknown capability id: {capability_id}")


__all__ = [
    "EFFECTFUL_CAPABILITIES",
    "PURE_CAPABILITIES",
    "Classification",
    "classify",
]
