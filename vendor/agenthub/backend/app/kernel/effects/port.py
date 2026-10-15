from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from app.kernel.effects.command import Command


class EffectResult(BaseModel):
    """Effect 层结果（纯数据，可 JSON 序列化）。不是 Receipt，更不是 Observation。"""

    model_config = ConfigDict(frozen=True)

    status: str
    committed: bool | None = None
    external_reference: str | None = None
    raw_response: Any = Field(default=None)
    error: str | None = None


class EffectPort(Protocol):
    """Kernel Runtime 依赖的抽象 Effect 端口；具体实现由外部注入。"""

    def execute_effect(self, command: Command) -> EffectResult: ...

    def query_effect(
        self,
        command: Command,
        external_reference: str | None = None,
    ) -> EffectResult: ...

    def can_retry(self, attempt_count: int) -> bool: ...

    def build_retry_command(self, original: Command, attempt: int) -> Command: ...


__all__ = ["EffectPort", "EffectResult"]
