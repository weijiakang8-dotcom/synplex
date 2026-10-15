"""Task fit first, then expected successful-delivery cost; legacy metadata stays usable."""

from dataclasses import dataclass
from typing import Any

from app.config import settings


@dataclass(frozen=True)
class ModelRequirements:
    tools: bool = False
    vision: bool = False
    structured_output: bool = False
    context_tokens: int = 0
    output_tokens: int = 4096
    task_type: str = "general"


def supports(config: dict[str, Any], requirement: ModelRequirements) -> bool:
    features = config.get("capabilities") or {}
    # Undeclared legacy OpenAI-compatible models may be probed for tools.
    if requirement.tools and features.get("tool_calling") is False:
        return False
    if requirement.vision and features.get("vision") is not True:
        return False
    if requirement.structured_output and features.get("structured_output") is not True:
        return False
    context = features.get("context_window") or settings.CONTEXT_UNKNOWN_WINDOW
    return int(context) * 0.9 >= requirement.context_tokens + requirement.output_tokens


def rank_models(models: list, requirements: ModelRequirements, complexity: str) -> list:
    candidates = [m for m in models if supports(m.config or {}, requirements)]

    def rank(model):
        config = model.config or {}
        profiles = config.get("task_profiles") or {}
        profile = (
            profiles.get(requirements.task_type)
            or profiles.get(requirements.task_type.removeprefix("agent:"))
            or {}
        )
        if not profile:
            return (
                1,
                model.priority if complexity == "complex" else -model.priority,
                model.cost_per_1k_tokens,
            )
        success = min(1.0, max(0.05, float(profile.get("success_rate", 0.5))))
        quality = float(profile.get("quality", success))
        input_rate = float(
            config.get("input_cost_per_1k_tokens", model.cost_per_1k_tokens)
        )
        output_rate = float(
            config.get("output_cost_per_1k_tokens", model.cost_per_1k_tokens)
        )
        expected_cost = (
            (
                requirements.context_tokens * input_rate
                + requirements.output_tokens * output_rate
            )
            / 1000
            / success
        )
        latency_penalty = float(profile.get("latency_seconds", 0)) * 0.001
        return (
            0,
            -quality if complexity == "complex" else expected_cost + latency_penalty,
            expected_cost,
        )

    return sorted(candidates, key=rank)
