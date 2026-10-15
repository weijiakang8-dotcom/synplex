from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum


class EvidenceLevel(StrEnum):
    L1_INFERRED = "L1_INFERRED"
    L2_SUPPORTED = "L2_SUPPORTED"
    L3_OBSERVED = "L3_OBSERVED"
    L4_ATTESTED = "L4_ATTESTED"


class EvidenceEventType(StrEnum):
    ARTIFACT_SUPPORTED = "ARTIFACT_SUPPORTED"
    OBSERVATION_RECORDED = "OBSERVATION_RECORDED"
    ATTESTATION_RECORDED = "ATTESTATION_RECORDED"


class IllegalEvidencePromotion(ValueError):
    """非法证据升级请求。"""


# 唯一合法升级路径：逐级、且必须由对应事件触发。
_LEGAL_PROMOTIONS: dict[tuple[EvidenceLevel, EvidenceEventType], EvidenceLevel] = {
    (
        EvidenceLevel.L1_INFERRED,
        EvidenceEventType.ARTIFACT_SUPPORTED,
    ): EvidenceLevel.L2_SUPPORTED,
    (
        EvidenceLevel.L2_SUPPORTED,
        EvidenceEventType.OBSERVATION_RECORDED,
    ): EvidenceLevel.L3_OBSERVED,
    (
        EvidenceLevel.L3_OBSERVED,
        EvidenceEventType.ATTESTATION_RECORDED,
    ): EvidenceLevel.L4_ATTESTED,
}

_EVIDENCE_ORDER: dict[EvidenceLevel, int] = {
    EvidenceLevel.L1_INFERRED: 1,
    EvidenceLevel.L2_SUPPORTED: 2,
    EvidenceLevel.L3_OBSERVED: 3,
    EvidenceLevel.L4_ATTESTED: 4,
}


def promote_evidence(
    current: EvidenceLevel,
    event: EvidenceEventType,
) -> EvidenceLevel:
    """按合法事件升级证据级别；非法跳级一律抛错，绝不静默放行。

    L1 -> L2 需要 Artifact 支撑。
    L2 -> L3 需要 Observation。
    L3 -> L4 需要 Attestation。
    L1 -> L3 / L1 -> L4 / L2 -> L4 均为非法。
    """
    next_level = _LEGAL_PROMOTIONS.get((current, event))
    if next_level is None:
        raise IllegalEvidencePromotion(
            f"illegal evidence promotion: {current.value} -> {event.value}"
        )
    return next_level


def is_promotion_legal(
    current: EvidenceLevel,
    event: EvidenceEventType,
) -> bool:
    return (current, event) in _LEGAL_PROMOTIONS


def satisfies_required_evidence(
    actual: EvidenceLevel,
    required: EvidenceLevel,
) -> bool:
    """actual 是否达到 required 的门槛。L1/L2 永远无法满足 L3。"""
    return _EVIDENCE_ORDER[actual] >= _EVIDENCE_ORDER[required]


def max_evidence_level(levels: Iterable[EvidenceLevel]) -> EvidenceLevel:
    """返回最高证据级别；空集合默认 L1。"""
    values = list(levels)
    if not values:
        return EvidenceLevel.L1_INFERRED
    return max(values, key=lambda level: _EVIDENCE_ORDER[level])


__all__ = [
    "EvidenceEventType",
    "EvidenceLevel",
    "IllegalEvidencePromotion",
    "is_promotion_legal",
    "max_evidence_level",
    "promote_evidence",
    "satisfies_required_evidence",
]
