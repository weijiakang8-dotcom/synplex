from __future__ import annotations


class CapabilityError(Exception):
    """Kernel Capability 语义层错误基类。"""


class UnknownCapabilityError(CapabilityError):
    """请求了未注册的 Capability。"""


class DuplicateCapabilityError(CapabilityError):
    """重复注册同一 capability_id。"""


class InvalidClassificationError(CapabilityError):
    """Capability 的 classification 与其 id 的固定分类不一致。"""


class InvalidCapabilityContractError(CapabilityError):
    """Capability 实现违反了其 Contract 的输出类型。"""


class UnknownPredicateError(CapabilityError):
    """引用了未定义的确定性 Predicate。"""


__all__ = [
    "CapabilityError",
    "DuplicateCapabilityError",
    "InvalidCapabilityContractError",
    "InvalidClassificationError",
    "UnknownCapabilityError",
    "UnknownPredicateError",
]
