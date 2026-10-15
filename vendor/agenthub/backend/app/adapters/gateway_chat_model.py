"""LangChain model adapter: all framework calls, including compression, use Gateway."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict, Field

from app.config import settings
from app.core.context_policy import (
    estimate_message_tokens,
    model_capacity,
    with_trust_policy,
)
from app.core.model_gateway import ModelGateway
from app.core.model_requirements import ModelRequirements


class WorkerBudgetExceeded(RuntimeError):
    pass


@dataclass
class CallLedger:
    budget: dict
    usage: list[dict] = field(default_factory=list)
    calls: int = 0
    max_calls: int = 12
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class GatewayChatModel(BaseChatModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    organization_id: str | None = None
    user_id: str | None = None
    execution_id: str
    task_type: str
    complexity: str = "simple"
    required_capabilities: list[str] = Field(default_factory=list)
    ledger: Any = Field(exclude=True)
    gateway: Any = Field(default_factory=ModelGateway, exclude=True)
    bound_tools: list = Field(default_factory=list)
    profile: dict = Field(
        default_factory=lambda: {
            "max_input_tokens": int(settings.CONTEXT_UNKNOWN_WINDOW * 0.9) - 4096
        }
    )

    @property
    def _llm_type(self):
        return "synplex-gateway"

    @property
    def _identifying_params(self):
        return {"model_name": "synplex-routed", "task_type": self.task_type}

    def bind_tools(self, tools, **kwargs):
        return self.model_copy(update={"bound_tools": list(tools)})

    async def prepare_context_profile(self, *, tools: bool) -> None:
        """Compression follows the smallest viable routed window, before graph creation."""
        candidates = await self.gateway.select(
            organization_id=self.organization_id,
            user_id=self.user_id,
            complexity=self.complexity,
            requirements=ModelRequirements(
                tools=tools,
                vision="vision" in self.required_capabilities,
                structured_output="structured_output" in self.required_capabilities,
                task_type=self.task_type,
            ),
        )
        limits = []
        for candidate in candidates:
            window, output, _ = model_capacity(candidate)
            limits.append(max(1, int(window * 0.9) - min(output, 4096)))
        if limits:
            self.profile = {"max_input_tokens": min(limits)}

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise RuntimeError("Synplex agent models require async invocation")

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        # Shared across deep-agent parent, specialists and summarization clones.
        async with self.ledger.lock:
            import uuid

            from app.engine.cancellation import ensure_execution_active

            await ensure_execution_active(uuid.UUID(self.execution_id))
            budget = self.ledger.budget
            from langchain_core.utils.function_calling import convert_to_openai_tool

            schemas = [convert_to_openai_tool(tool) for tool in self.bound_tools]
            estimate = (
                estimate_message_tokens(with_trust_policy(messages), schemas) + 4096
            )
            used_tokens = sum(
                int(u.get("input_tokens") or 0) + int(u.get("output_tokens") or 0)
                for u in self.ledger.usage
            )
            known_cost = sum(float(u.get("cost") or 0) for u in self.ledger.usage)
            if self.ledger.calls >= self.ledger.max_calls or int(
                budget.get("tokens", 0)
            ) + used_tokens + estimate > int(budget.get("max_tokens", 100000)):
                raise WorkerBudgetExceeded("worker token/call budget exceeded")
            if time.time() - float(budget.get("started_at", time.time())) >= float(
                budget.get("wall_clock_seconds", 300)
            ):
                raise WorkerBudgetExceeded("worker wall-clock budget exceeded")
            if float(budget.get("cost", 0)) + known_cost >= float(
                budget.get("max_cost", 10)
            ):
                raise WorkerBudgetExceeded("worker cost budget exceeded")
            self.ledger.calls += 1
            llms = await self.gateway.select(
                organization_id=self.organization_id,
                user_id=self.user_id,
                complexity=self.complexity,
                requirements=ModelRequirements(
                    tools=bool(self.bound_tools),
                    vision="vision" in self.required_capabilities,
                    structured_output="structured_output" in self.required_capabilities,
                    context_tokens=estimate - 4096,
                    task_type=self.task_type,
                ),
            )
            if hasattr(self.gateway, "_rate_for_model"):
                rates = await asyncio.gather(
                    *[
                        self.gateway._rate_for_model(
                            getattr(llm, "model_name", None), self.organization_id
                        )
                        for llm in llms
                    ]
                )
                remaining_cost = (
                    float(budget.get("max_cost", 10))
                    - float(budget.get("cost", 0))
                    - known_cost
                )
                llms = [
                    llm
                    for llm, rate in zip(llms, rates, strict=True)
                    if rate is None or estimate / 1000 * rate <= remaining_cost
                ]
                if not llms:
                    raise WorkerBudgetExceeded(
                        "worker estimated call cost exceeds remaining budget"
                    )
            llms = [
                (
                    llm.model_copy(
                        update={
                            "max_tokens": min(
                                int(getattr(llm, "max_tokens", None) or 4096), 4096
                            )
                        }
                    )
                    if hasattr(llm, "model_copy")
                    else llm
                )
                for llm in llms
            ]
            if self.bound_tools:
                llms = [llm.bind_tools(self.bound_tools) for llm in llms]
            response = await self.gateway.invoke(
                llms,
                messages,
                task_type=self.task_type,
                organization_id=self.organization_id,
                correlation_id=self.execution_id,
            )
            usage = (response.additional_kwargs or {}).get("_agenthub_llm") or {}
            self.ledger.usage.append(usage)
            # Exactly one durable usage row per completed framework model call.
            from app.core.profile import record_usage_events

            await record_usage_events(
                [usage],
                execution_id=self.execution_id,
                organization_id=self.organization_id,
                user_id=self.user_id,
                task_type=self.task_type,
                step_capability="general",
                complexity=self.complexity,
            )
            return ChatResult(generations=[ChatGeneration(message=response)])
