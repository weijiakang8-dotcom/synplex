from __future__ import annotations

from collections.abc import Callable

from app.kernel.effects.command import Command

CommandIdFactory = Callable[[str, int], str]


def _default_command_id_factory(idempotency_key: str, attempt: int) -> str:
    return f"{idempotency_key}:attempt:{attempt}"


class RetryPolicy:
    """确定性 retry 资格与命令重建。无 backoff、无真实时钟、无异步。"""

    def __init__(
        self, max_retries: int, command_id_factory: CommandIdFactory | None = None
    ):
        self.max_retries = max_retries
        self._command_id_factory = command_id_factory or _default_command_id_factory

    def eligible(self, attempt_count: int) -> bool:
        return attempt_count < self.max_retries

    def build_retry_command(self, original: Command, attempt: int) -> Command:
        return Command(
            command_id=self._command_id_factory(original.idempotency_key, attempt),
            idempotency_key=original.idempotency_key,
            capability_id=original.capability_id,
            payload=original.payload,
            created_at_logical=original.created_at_logical + 1,
        )


__all__ = ["RetryPolicy"]
