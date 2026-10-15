from __future__ import annotations

from typing import Any

from app.kernel.effects.retry import RetryPolicy
from app.kernel.effects.simulator import DeterministicWorldSimulator
from app.kernel.effects.simulator_port import SimulatorEffectPort


def build_effect_port(settings: Any):
    """Composition root：根据配置选择真实或模拟 EffectPort。

    KernelRuntime 不得读取 settings；选择逻辑只存在于 Adapter/Engine boundary。
    """
    if getattr(settings, "REAL_EFFECT_MODE", False):
        from app.adapters.real_effect_executor import RealEffectExecutor

        return RealEffectExecutor()

    return SimulatorEffectPort(
        DeterministicWorldSimulator(),
        RetryPolicy(max_retries=1),
    )


__all__ = ["build_effect_port"]
