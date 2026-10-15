"""统一 Model Gateway（Frozen Core）。

业务代码不直接决定具体模型，只表达任务类型/复杂度与租户上下文。
所有调用通过 Gateway 落结构化观测：model/provider/attempt/tokens/latency/fallback/error。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import Any
from urllib.parse import urlsplit

from langchain_core.messages import AIMessage, BaseMessage
from langchain_openai import ChatOpenAI
from sqlalchemy import select

from app.config import settings
from app.core.circuit_breaker import llm_breaker
from app.core.context_policy import (
    ContextCapacityError,
    admit_messages,
    with_trust_policy,
)
from app.core.failure import (
    LLM_RETRY_POLICY,
    classify_error,
    should_retry,
)
from app.core.model_requirements import ModelRequirements, rank_models
from app.core.quota import (
    QuotaExceededError,
    acquire_llm_slot,
    estimate_tokens_for_messages,
    release_llm_slot,
    reserve_cost,
    reserve_tokens,
    settle_cost,
    settle_tokens,
)
from app.core.security import decrypt_secret
from app.database import async_session_factory
from app.engine.observability import record_span
from app.models import ModelConfig, UserApiKey

logger = logging.getLogger("agenthub.model")


async def list_active_models(organization_id: str | None = None) -> list[ModelConfig]:
    async with async_session_factory() as session:
        if organization_id is not None:
            stmt = select(ModelConfig).where(
                ModelConfig.is_active.is_(True),
                ModelConfig.enabled.is_(True),
                ModelConfig.organization_id == organization_id,
            )
            result = await session.execute(
                stmt.order_by(ModelConfig.cost_per_1k_tokens)
            )
            rows = list(result.scalars().all())
            if rows:
                return rows
        stmt = select(ModelConfig).where(
            ModelConfig.is_active.is_(True),
            ModelConfig.enabled.is_(True),
            ModelConfig.organization_id.is_(None),
        )
        result = await session.execute(stmt.order_by(ModelConfig.cost_per_1k_tokens))
        return list(result.scalars().all())


def _user_key_uses_responses_api(key: UserApiKey) -> bool:
    host = (urlsplit(key.base_url).hostname or "").lower()
    return key.provider.endswith(":responses") or host == "api.openai.com"


async def list_user_api_keys(user_id: str | uuid.UUID | None) -> list[UserApiKey]:
    if user_id is None:
        return []
    async with async_session_factory() as session:
        result = await session.execute(
            select(UserApiKey)
            .where(
                UserApiKey.user_id == uuid.UUID(str(user_id)),
                UserApiKey.is_active.is_(True),
            )
            .order_by(UserApiKey.created_at)
        )
        return list(result.scalars().all())


def get_chat_model(
    model: ModelConfig, *, reasoning_effort: str | None = None
) -> ChatOpenAI:
    """构造客户端。``reasoning_effort`` 传入时覆盖配置里的默认等级。

    覆盖用于会话级选择：同一个 ModelConfig 在不同会话里可以用不同思考等级。
    """
    configured = (getattr(model, "config", None) or {}).get("reasoning_effort")
    return ChatOpenAI(
        model=model.model,
        base_url=model.base_url,
        api_key=model.api_key or "not-configured",
        max_tokens=model.max_tokens,
        temperature=0,
        reasoning_effort=reasoning_effort if reasoning_effort else configured,
        request_timeout=max(1, model.timeout),
        max_retries=max(0, model.max_retries),
        metadata={
            "synplex_context_window": (getattr(model, "config", None) or {})
            .get("capabilities", {})
            .get("context_window")
        },
    )


def _fallback_client() -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.LLM_MODEL,
        base_url=settings.LLM_BASE_URL,
        api_key=settings.OPENAI_API_KEY or "not-configured",
        temperature=0,
        request_timeout=120,
        max_retries=2,
    )


def _secondary_fallback_client() -> ChatOpenAI | None:
    """第二供应商（OpenAI）备用客户端；未启用或未配置密钥时返回 None（自动跳过）。"""
    if not settings.OPENAI_FALLBACK_ENABLED:
        return None
    if not settings.OPENAI_FALLBACK_API_KEY:
        logger.warning(
            "OpenAI fallback enabled but OPENAI_FALLBACK_API_KEY is empty; "
            "secondary provider skipped"
        )
        return None
    return ChatOpenAI(
        model=settings.OPENAI_FALLBACK_MODEL,
        base_url=settings.OPENAI_FALLBACK_BASE_URL,
        api_key=settings.OPENAI_FALLBACK_API_KEY,
        temperature=0,
        request_timeout=120,
        max_retries=0,
    )


_active_selection: ContextVar[dict[str, Any] | None] = ContextVar(
    "synplex_model_selection", default=None
)


def set_active_selection(selection: dict[str, Any] | None) -> None:
    """为当前执行设置会话级模型选择，供本次运行内所有模型调用沿用。"""
    _active_selection.set(selection or None)


def get_active_selection() -> dict[str, Any] | None:
    return _active_selection.get()


async def get_chat_models(
    organization_id: str | None = None,
    *,
    complexity: str = "simple",
    user_id: str | uuid.UUID | None = None,
    selection: dict[str, Any] | None = None,
) -> list[ChatOpenAI]:
    """兼容旧调用点的模型选择逻辑（现在统一委托给 ModelGateway）。"""
    return await ModelGateway().select(
        organization_id=organization_id,
        complexity=complexity,
        user_id=user_id,
        selection=selection if selection is not None else get_active_selection(),
    )


async def resolve_model(
    organization_id: str | None = None,
    *,
    complexity: str = "simple",
) -> ModelConfig | None:
    models = await list_active_models(organization_id)
    if not models:
        return None
    if complexity == "complex":
        return max(models, key=lambda m: m.cost_per_1k_tokens)
    return min(models, key=lambda m: m.cost_per_1k_tokens)


async def test_model(model: ModelConfig) -> dict[str, Any]:
    llm = get_chat_model(model)
    try:
        response = await asyncio.wait_for(
            llm.ainvoke([{"role": "user", "content": "ping"}]),
            timeout=15,
        )
        return {"ok": True, "response": str(getattr(response, "content", ""))[:120]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


class ModelGateway:
    """模型选择 + 统一重试/回退 + 结构化观测。"""

    async def select(
        self,
        *,
        organization_id: str | None = None,
        complexity: str = "simple",
        user_id: str | uuid.UUID | None = None,
        requirements: ModelRequirements | None = None,
        selection: dict[str, Any] | None = None,
    ) -> list[ChatOpenAI]:
        if selection:
            # 会话级显式选择优先且不打折：用户选了哪个就跑哪个，不再按复杂度改路由。
            from app.core.model_selection import resolve_selection

            models = await list_active_models(organization_id)
            resolved = await resolve_selection(
                organization_id, selection, active_models=models
            )
            if resolved is not None:
                chosen, effort = resolved
                client = get_chat_model(chosen, reasoning_effort=effort or None)
                client.metadata = {
                    **(client.metadata or {}),
                    "synplex_selection": True,
                    "provider": chosen.provider,
                    "model": chosen.model,
                    "reasoning_effort": effort or None,
                }
                return self._tag_selection([client], complexity)

        user_llms: list[ChatOpenAI] = []
        for key in await list_user_api_keys(user_id):
            secret = decrypt_secret(key.api_key_encrypted)
            if secret:
                uses_responses = _user_key_uses_responses_api(key)
                user_llms.append(
                    ChatOpenAI(
                        model=key.model,
                        base_url=key.base_url,
                        api_key=secret,
                        temperature=None if uses_responses else 0,
                        request_timeout=120,
                        max_retries=2,
                        use_responses_api=uses_responses,
                        metadata={
                            "provider": key.provider.removesuffix(":responses"),
                            "api_mode": (
                                "responses" if uses_responses else "chat_completions"
                            ),
                        },
                    )
                )

        models = await list_active_models(organization_id)
        secondary = _secondary_fallback_client()
        if not models:
            if requirements and (requirements.vision or requirements.structured_output):
                raise ValueError("No model satisfies required capabilities")
            clients = [*user_llms, _fallback_client()]
            if secondary is not None:
                clients.append(secondary)
            return self._tag_selection(clients, complexity)

        strict = bool(
            requirements and (requirements.vision or requirements.structured_output)
        )
        if requirements:
            declared_names = {m.model for m in models}
            models = await self._rank_for_task(
                models, requirements, complexity, organization_id
            )
            eligible_names = {m.model for m in models}
            user_llms = [
                llm
                for llm in user_llms
                if llm.model_name in eligible_names
                or (not strict and llm.model_name not in declared_names)
            ]
            if not models and not user_llms:
                raise ValueError("No model satisfies required capabilities")
        elif complexity == "complex":
            models = sorted(models, key=lambda m: (m.priority, m.cost_per_1k_tokens))
        else:
            models = sorted(models, key=lambda m: (-m.priority, m.cost_per_1k_tokens))
        clients = [*user_llms, *[get_chat_model(model) for model in models]]
        if requirements:
            order = {m.model: i for i, m in enumerate(models)}
            clients.sort(key=lambda llm: order.get(llm.model_name, len(order)))
        if secondary is not None and not strict:
            clients.append(secondary)
        return self._tag_selection(clients, complexity)

    @staticmethod
    def _tag_selection(clients, complexity):
        for client in clients:
            if hasattr(client, "metadata"):
                client.metadata = {
                    **(client.metadata or {}),
                    "synplex_complexity": complexity,
                }
        return clients

    async def _rank_for_task(self, models, requirements, complexity, organization_id):
        from app.core.profile import stats_for

        for model in models:
            stats = await stats_for(
                organization_id,
                model=model.model,
                task_type=f"delivered:{requirements.task_type}",
                bucket=complexity,
            )
            if stats.get("attempts", 0) >= 5 and stats.get("success_rate") is not None:
                config = dict(model.config or {})
                profiles = dict(config.get("task_profiles") or {})
                profile = dict(profiles.get(requirements.task_type) or {})
                profile.update(
                    success_rate=stats["success_rate"], quality=stats["success_rate"]
                )
                profiles[requirements.task_type] = profile
                config["task_profiles"] = profiles
                model.config = config
        return rank_models(models, requirements, complexity)

    async def _persist_execution_call(
        self, response, task_type, organization_id, correlation_id
    ):
        if not correlation_id:
            return
        try:
            from app.core.profile import record_usage_events
            from app.models import Execution

            async with async_session_factory() as session:
                execution = await session.get(Execution, uuid.UUID(str(correlation_id)))
                if not execution or str(execution.organization_id or "") != str(
                    organization_id or ""
                ):
                    return
                await record_usage_events(
                    [(response.additional_kwargs or {}).get("_agenthub_llm") or {}],
                    execution_id=str(execution.id),
                    organization_id=organization_id,
                    user_id=str(execution.user_id) if execution.user_id else None,
                    task_type=task_type,
                    step_capability=task_type.removeprefix("agent:"),
                    complexity=(
                        (response.additional_kwargs or {}).get("_agenthub_llm") or {}
                    ).get("complexity", "simple"),
                )
        except Exception:
            logger.warning("Could not persist execution model call", exc_info=True)

    def _record(
        self,
        *,
        task_type: str,
        model: str | None,
        attempt: int,
        fallback: bool,
        streaming: bool,
        latency: float,
        organization_id: str | None,
        correlation_id: str | None,
        status: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost: float | None = None,
        error: str | None = None,
    ) -> None:
        logger.info(
            json.dumps(
                {
                    "event": "model_call",
                    "task_type": task_type,
                    "model": model,
                    "attempt": attempt,
                    "fallback": fallback,
                    "streaming": streaming,
                    "latency_ms": round(latency * 1000, 2),
                    "organization_id": organization_id,
                    "correlation_id": correlation_id,
                    "status": status,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cost": cost,
                    "error": error,
                },
                ensure_ascii=False,
            )
        )

    def _model_name(self, llm: ChatOpenAI) -> str | None:
        return getattr(llm, "model_name", None) or getattr(
            getattr(llm, "bound", None), "model_name", None
        )

    def _usage(self, response: Any) -> tuple[int, int]:
        usage = getattr(response, "usage_metadata", None) or {}
        return int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0)

    async def _rate_for_model(
        self, model_name: str | None, organization_id: str | None
    ) -> float | None:
        if not model_name:
            return None
        stmt = select(ModelConfig).where(
            ModelConfig.is_active.is_(True),
            ModelConfig.enabled.is_(True),
            ModelConfig.model == model_name,
        )
        async with async_session_factory() as session:
            candidates = list((await session.execute(stmt)).scalars().all())
        for candidate in candidates:
            if candidate.organization_id is not None and (
                organization_id is not None
                and str(candidate.organization_id) == str(organization_id)
            ):
                return float(candidate.cost_per_1k_tokens)
        for candidate in candidates:
            if candidate.organization_id is None:
                return float(candidate.cost_per_1k_tokens)
        return None

    async def _cost_for(
        self,
        model_name: str | None,
        organization_id: str | None,
        input_tokens: int,
        output_tokens: int,
    ) -> float | None:
        rate = await self._rate_for_model(model_name, organization_id)
        if rate is None or (input_tokens + output_tokens) <= 0:
            return None
        return round((input_tokens + output_tokens) / 1000 * rate, 8)

    async def invoke(
        self,
        llms: list[ChatOpenAI],
        messages: list[BaseMessage],
        *,
        task_type: str,
        organization_id: str | None = None,
        correlation_id: str | None = None,
    ) -> AIMessage:
        messages = with_trust_policy(messages)
        last_error: Exception | None = None
        for model_index, llm in enumerate(llms):
            try:
                context = admit_messages(llm, messages)
            except ContextCapacityError as exc:
                last_error = exc
                self._record(
                    task_type=task_type,
                    model=self._model_name(llm),
                    attempt=0,
                    fallback=model_index > 0,
                    streaming=False,
                    latency=0,
                    organization_id=organization_id,
                    correlation_id=correlation_id,
                    status="context_rejected",
                    error=str(exc),
                )
                continue
            if not llm_breaker.allow():
                continue
            for attempt in range(LLM_RETRY_POLICY.max_attempts):
                start = time.perf_counter()
                slot_acquired = False
                estimate = 0
                estimate_cost_cny = 0.0
                try:
                    if organization_id:
                        if not await acquire_llm_slot(organization_id):
                            raise QuotaExceededError(
                                "当前租户并发模型调用已达上限，请稍后再试。"
                            )
                        slot_acquired = True
                        estimate = context["input_estimate"] + context["output_reserve"]
                        await reserve_tokens(organization_id, estimate=estimate)
                        rate = await self._rate_for_model(
                            self._model_name(llm), organization_id
                        )
                        if rate is not None:
                            estimate_cost_cny = estimate / 1000.0 * rate
                            await reserve_cost(
                                organization_id,
                                estimate_cny=estimate_cost_cny,
                            )
                    response = await llm.ainvoke(messages)
                    latency = time.perf_counter() - start
                    input_tokens, output_tokens = self._usage(response)
                    usage_source = (
                        "provider" if input_tokens or output_tokens else "estimate"
                    )
                    if usage_source == "estimate":
                        input_tokens = context["input_estimate"]
                        output_tokens = estimate_tokens_for_messages([response])
                    cost = await self._cost_for(
                        self._model_name(llm),
                        organization_id,
                        input_tokens,
                        output_tokens,
                    )
                    if slot_acquired:
                        await settle_tokens(
                            organization_id,
                            estimate=estimate,
                            actual=input_tokens + output_tokens,
                        )
                        await settle_cost(
                            organization_id,
                            estimate_cny=estimate_cost_cny,
                            actual_cny=cost or 0.0,
                        )
                    llm_breaker.record_success()
                    self._attach_metadata(
                        response,
                        model=self._model_name(llm),
                        fallback=model_index > 0,
                        attempts=attempt + 1,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cost=cost,
                    )
                    selected = getattr(llm, "bound", llm)
                    response.additional_kwargs["_agenthub_llm"][
                        "usage_source"
                    ] = usage_source
                    response.additional_kwargs.setdefault("_agenthub_llm", {})[
                        "complexity"
                    ] = (getattr(selected, "metadata", None) or {}).get(
                        "synplex_complexity", "simple"
                    )
                    await self._persist_execution_call(
                        response, task_type, organization_id, correlation_id
                    )
                    self._record(
                        task_type=task_type,
                        model=self._model_name(llm),
                        attempt=attempt + 1,
                        fallback=model_index > 0,
                        streaming=False,
                        latency=latency,
                        organization_id=organization_id,
                        correlation_id=correlation_id,
                        status="success",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cost=cost,
                    )
                    await record_span(
                        trace_id=correlation_id,
                        name="llm",
                        status="ok",
                        tokens=input_tokens + output_tokens,
                        cost=cost,
                        model=self._model_name(llm),
                        attempt=attempt + 1,
                        details={
                            "task_type": task_type,
                            "context": context,
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "fallback": model_index > 0,
                            "streaming": False,
                        },
                    )
                    if slot_acquired:
                        await release_llm_slot(organization_id)
                    return response
                except QuotaExceededError:
                    if slot_acquired:
                        await release_llm_slot(organization_id)
                    raise
                except Exception as exc:  # noqa: BLE001
                    if slot_acquired:
                        await release_llm_slot(organization_id)
                        slot_acquired = False
                    llm_breaker.record_failure()
                    last_error = exc
                    category = classify_error(exc)
                    self._record(
                        task_type=task_type,
                        model=self._model_name(llm),
                        attempt=attempt + 1,
                        fallback=model_index > 0,
                        streaming=False,
                        latency=time.perf_counter() - start,
                        organization_id=organization_id,
                        correlation_id=correlation_id,
                        status="error",
                        error=f"{category.value}: {str(exc)[:200]}",
                    )
                    await record_span(
                        trace_id=correlation_id,
                        name="llm",
                        status="error",
                        model=self._model_name(llm),
                        attempt=attempt + 1,
                        error=f"{category.value}: {str(exc)[:200]}",
                        details={
                            "task_type": task_type,
                            "fallback": model_index > 0,
                            "streaming": False,
                        },
                    )
                    if not should_retry(category, "llm"):
                        break
                    if attempt + 1 < LLM_RETRY_POLICY.max_attempts:
                        await asyncio.sleep(LLM_RETRY_POLICY.delay(attempt))
                if slot_acquired:
                    await release_llm_slot(organization_id)
        raise last_error or RuntimeError("AI 服务暂时不可用，请稍后再试")

    async def stream(
        self,
        llms: list[ChatOpenAI],
        messages: list[BaseMessage],
        *,
        task_type: str,
        organization_id: str | None = None,
        correlation_id: str | None = None,
        usage_sink: list | None = None,
    ) -> AsyncIterator[str]:
        messages = with_trust_policy(messages)
        last_error: Exception | None = None
        emitted = False
        for model_index, llm in enumerate(llms):
            try:
                context = admit_messages(llm, messages)
            except ContextCapacityError as exc:
                last_error = exc
                self._record(
                    task_type=task_type,
                    model=self._model_name(llm),
                    attempt=0,
                    fallback=model_index > 0,
                    streaming=True,
                    latency=0,
                    organization_id=organization_id,
                    correlation_id=correlation_id,
                    status="context_rejected",
                    error=str(exc),
                )
                continue
            if not llm_breaker.allow():
                continue
            parts: list[str] = []
            start = time.perf_counter()
            slot_acquired = False
            estimate = 0
            estimate_cost_cny = 0.0
            input_estimate = context["input_estimate"]
            reported_usage = (0, 0)
            receipt = None
            try:
                if organization_id:
                    if not await acquire_llm_slot(organization_id):
                        raise QuotaExceededError(
                            "当前租户并发模型调用已达上限，请稍后再试。"
                        )
                    slot_acquired = True
                    estimate = input_estimate + context["output_reserve"]
                    await reserve_tokens(organization_id, estimate=estimate)
                    rate = await self._rate_for_model(
                        self._model_name(llm), organization_id
                    )
                    if rate is not None:
                        estimate_cost_cny = estimate / 1000.0 * rate
                        await reserve_cost(
                            organization_id,
                            estimate_cny=estimate_cost_cny,
                        )
                async for chunk in llm.astream(messages):
                    chunk_usage = self._usage(chunk)
                    if any(chunk_usage):
                        reported_usage = chunk_usage
                    text = getattr(chunk, "content", None)
                    if isinstance(text, str) and text:
                        emitted = True
                        parts.append(text)
                        yield text
                llm_breaker.record_success()
                actual_input, stream_tokens = (
                    reported_usage
                    if any(reported_usage)
                    else (
                        input_estimate,
                        estimate_tokens_for_messages(
                            [AIMessage(content="".join(parts))]
                        ),
                    )
                )
                cost = await self._cost_for(
                    self._model_name(llm), organization_id, actual_input, stream_tokens
                )
                receipt = AIMessage(content="".join(parts))
                self._attach_metadata(
                    receipt,
                    model=self._model_name(llm),
                    fallback=model_index > 0,
                    attempts=1,
                    input_tokens=actual_input,
                    output_tokens=stream_tokens,
                    cost=cost,
                )
                receipt.additional_kwargs["_agenthub_llm"]["usage_source"] = (
                    "provider" if any(reported_usage) else "estimate"
                )
                if usage_sink is not None:
                    usage_sink.append(receipt.additional_kwargs["_agenthub_llm"])
                await self._persist_execution_call(
                    receipt, task_type, organization_id, correlation_id
                )
                if slot_acquired:
                    await settle_tokens(
                        organization_id,
                        estimate=estimate,
                        actual=actual_input + stream_tokens,
                    )
                    await settle_cost(
                        organization_id,
                        estimate_cny=estimate_cost_cny,
                        actual_cny=cost or 0.0,
                    )
                self._record(
                    task_type=task_type,
                    model=self._model_name(llm),
                    attempt=1,
                    fallback=model_index > 0,
                    streaming=True,
                    latency=time.perf_counter() - start,
                    organization_id=organization_id,
                    correlation_id=correlation_id,
                    status="success",
                    input_tokens=actual_input,
                    output_tokens=stream_tokens,
                    cost=cost,
                )
                await record_span(
                    trace_id=correlation_id,
                    name="llm",
                    status="ok",
                    tokens=actual_input + stream_tokens,
                    cost=cost,
                    model=self._model_name(llm),
                    attempt=1,
                    details={
                        "task_type": task_type,
                        "context": context,
                        "fallback": model_index > 0,
                        "streaming": True,
                    },
                )
                if slot_acquired:
                    await release_llm_slot(organization_id)
                return
            except QuotaExceededError:
                if slot_acquired:
                    await release_llm_slot(organization_id)
                raise
            except Exception as exc:
                if receipt is None and (parts or any(reported_usage)):
                    # Interrupted calls consumed tokens too. Persist the partial
                    # receipt before reporting failure; never retry emitted text.
                    actual_input, stream_tokens = (
                        reported_usage
                        if any(reported_usage)
                        else (
                            input_estimate,
                            estimate_tokens_for_messages(
                                [AIMessage(content="".join(parts))]
                            ),
                        )
                    )
                    cost = await self._cost_for(
                        self._model_name(llm),
                        organization_id,
                        actual_input,
                        stream_tokens,
                    )
                    receipt = AIMessage(content="".join(parts))
                    self._attach_metadata(
                        receipt,
                        model=self._model_name(llm),
                        fallback=model_index > 0,
                        attempts=1,
                        input_tokens=actual_input,
                        output_tokens=stream_tokens,
                        cost=cost,
                    )
                    receipt.additional_kwargs["_agenthub_llm"].update(
                        usage_source="provider" if any(reported_usage) else "estimate",
                        interrupted=True,
                    )
                    if usage_sink is not None:
                        usage_sink.append(receipt.additional_kwargs["_agenthub_llm"])
                    await self._persist_execution_call(
                        receipt, task_type, organization_id, correlation_id
                    )
                    if slot_acquired:
                        await settle_tokens(
                            organization_id,
                            estimate=estimate,
                            actual=actual_input + stream_tokens,
                        )
                        await settle_cost(
                            organization_id,
                            estimate_cny=estimate_cost_cny,
                            actual_cny=cost or 0.0,
                        )
                if slot_acquired:
                    await release_llm_slot(organization_id)
                    slot_acquired = False
                llm_breaker.record_failure()
                last_error = exc
                category = classify_error(exc)
                self._record(
                    task_type=task_type,
                    model=self._model_name(llm),
                    attempt=1,
                    fallback=model_index > 0,
                    streaming=True,
                    latency=time.perf_counter() - start,
                    organization_id=organization_id,
                    correlation_id=correlation_id,
                    status="error",
                    error=f"{category.value}: {str(exc)[:200]}",
                )
                await record_span(
                    trace_id=correlation_id,
                    name="llm",
                    status="error",
                    model=self._model_name(llm),
                    attempt=1,
                    error=f"{category.value}: {str(exc)[:200]}",
                    details={
                        "task_type": task_type,
                        "fallback": model_index > 0,
                        "streaming": True,
                    },
                )
                if emitted or not should_retry(category, "llm"):
                    if emitted:
                        # A partial stream is not a completed answer. Never switch
                        # providers after emitting text, but report the interruption.
                        raise
                    continue
        if emitted:
            return
        raise last_error or RuntimeError("AI 服务暂时不可用，请稍后再试")

    def _attach_metadata(
        self,
        response: AIMessage,
        *,
        model: str | None,
        fallback: bool,
        attempts: int,
        input_tokens: int,
        output_tokens: int,
        cost: float | None,
    ) -> None:
        kwargs = dict(getattr(response, "additional_kwargs", None) or {})
        kwargs["_agenthub_llm"] = {
            "call_id": str(uuid.uuid4()),
            "model_used": model or "",
            "fallback": fallback,
            "attempts": attempts,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost": cost,
        }
        response.additional_kwargs = kwargs


__all__ = [
    "ModelGateway",
    "get_chat_model",
    "get_chat_models",
    "list_active_models",
    "list_user_api_keys",
    "resolve_model",
    "test_model",
]
