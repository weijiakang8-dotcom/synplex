from __future__ import annotations

from collections.abc import Callable

from app.kernel.capability.classification import classify
from app.kernel.capability.errors import (
    DuplicateCapabilityError,
    InvalidClassificationError,
    UnknownCapabilityError,
)
from app.kernel.capability.model import CapabilityDefinition, CapabilityId


class CapabilityRegistry:
    """Capability 的唯一真相源。"""

    def __init__(self) -> None:
        self._definitions: dict[CapabilityId, CapabilityDefinition] = {}
        self._implementations: dict[CapabilityId, Callable] = {}

    def register(
        self,
        definition: CapabilityDefinition,
        implementation: Callable,
    ) -> None:
        capability_id = definition.capability_id
        if capability_id in self._definitions:
            raise DuplicateCapabilityError(
                f"capability already registered: {capability_id.value}"
            )

        expected = classify(capability_id)
        if definition.classification != expected:
            raise InvalidClassificationError(
                f"{capability_id.value} must be {expected.value}"
            )

        self._definitions[capability_id] = definition
        self._implementations[capability_id] = implementation

    def get(self, capability_id: CapabilityId) -> CapabilityDefinition | None:
        return self._definitions.get(capability_id)

    def resolve(
        self,
        capability_id: CapabilityId,
    ) -> tuple[CapabilityDefinition, Callable]:
        definition = self._definitions.get(capability_id)
        if definition is None:
            raise UnknownCapabilityError(f"unknown capability: {capability_id.value}")
        return definition, self._implementations[capability_id]

    def ids(self) -> list[CapabilityId]:
        return sorted(self._definitions.keys())


__all__ = ["CapabilityRegistry"]
