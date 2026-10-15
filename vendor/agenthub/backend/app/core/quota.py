"""租户预算与并发闸门（Redis 原子实现，Frozen 边界之外的扩展点）。

- 月度 token / 成本预算：Lua 原子「检查 + 增加」，超限返回拒绝，绝不超发。
- 并发模型调用闸门：Lua 原子「检查 + 增加」，调用结束后释放（带 TTL 防泄漏）。
- 预算未配置（0）时不限制，保持与旧行为一致。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)


class QuotaExceededError(RuntimeError):
    """租户预算/并发上限已用尽；调用方应转为用户可见错误。"""


def _redis() -> aioredis.Redis:
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


def month_key(organization_id: str) -> str:
    now = datetime.now(timezone.utc)
    return f"quota:{organization_id}:{now.year:04d}-{now.month:02d}"


def cost_key(organization_id: str) -> str:
    return f"{month_key(organization_id)}:cost_milli"


def _monthly_token_limit() -> int:
    return max(0, int(settings.TENANT_MONTHLY_TOKEN_BUDGET or 0))


def _monthly_cost_limit_cny() -> float:
    return max(0.0, float(settings.TENANT_MONTHLY_COST_BUDGET_CNY or 0.0))


def _concurrent_limit() -> int:
    return max(0, int(settings.TENANT_MAX_CONCURRENT_LLM_CALLS or 0))


def _limit_key(organization_id: str, kind: str) -> str:
    return f"quota:limit:{organization_id}:{kind}"


async def _read_override(
    client: aioredis.Redis, organization_id: str, kind: str
) -> int | None:
    raw = await client.get(_limit_key(organization_id, kind))
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


async def _effective_token_limit(
    client: aioredis.Redis, organization_id: str | None
) -> int:
    if not organization_id:
        return _monthly_token_limit()
    override = await _read_override(client, organization_id, "tokens")
    return max(0, override if override is not None else _monthly_token_limit())


async def _effective_cost_limit_cny(
    client: aioredis.Redis, organization_id: str | None
) -> float:
    if not organization_id:
        return _monthly_cost_limit_cny()
    override = await _read_override(client, organization_id, "cost_milli")
    if override is None:
        return _monthly_cost_limit_cny()
    return max(0.0, override / 1000.0)


async def _effective_concurrent_limit(
    client: aioredis.Redis, organization_id: str | None
) -> int:
    if not organization_id:
        return _concurrent_limit()
    override = await _read_override(client, organization_id, "concurrent")
    return max(0, override if override is not None else _concurrent_limit())


async def set_quota_limits(
    organization_id: str,
    *,
    monthly_token_budget: int | None = None,
    monthly_cost_budget_cny: float | None = None,
    concurrent_llm_limit: int | None = None,
) -> None:
    """为租户写入 Redis 配额覆盖（0 = 不限制；不传 = 保持现值）。"""
    client = _redis()
    try:
        if monthly_token_budget is not None:
            await client.set(
                _limit_key(organization_id, "tokens"),
                max(0, int(monthly_token_budget)),
            )
        if monthly_cost_budget_cny is not None:
            await client.set(
                _limit_key(organization_id, "cost_milli"),
                max(0, int(float(monthly_cost_budget_cny) * 1000)),
            )
        if concurrent_llm_limit is not None:
            await client.set(
                _limit_key(organization_id, "concurrent"),
                max(0, int(concurrent_llm_limit)),
            )
    finally:
        await client.aclose()


_INCR_IF_WITHIN = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local delta = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if limit > 0 and current + delta > limit then
  return -1
end
redis.call('INCRBY', KEYS[1], delta)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return current + delta
"""


async def _incr_if_within(
    client: aioredis.Redis,
    key: str,
    delta: int,
    limit: int,
    ttl: int,
) -> int:
    script = client.register_script(_INCR_IF_WITHIN)
    return int(await script(keys=[key], args=[delta, limit, ttl]))


async def _usage(client: aioredis.Redis, key: str) -> int:
    value = await client.get(key)
    return int(value or 0)


async def check_token_budget(organization_id: str | None) -> None:
    """调用前检查：不预占，仅保证已用额度未超限。"""
    if not organization_id:
        return
    client = _redis()
    try:
        limit = await _effective_token_limit(client, organization_id)
        if limit <= 0:
            return
        used = await _usage(client, month_key(organization_id))
    finally:
        await client.aclose()
    if used >= limit:
        raise QuotaExceededError(
            f"本月 token 预算已用尽（{used}/{limit}），请等待下月或提升配额。"
        )


async def reserve_tokens(
    organization_id: str | None,
    *,
    estimate: int,
) -> None:
    """原子预占：估算（输入估算 + 输出上限）超出预算时硬阻断。"""
    if not organization_id or estimate <= 0:
        return
    client = _redis()
    try:
        limit = await _effective_token_limit(client, organization_id)
        if limit <= 0:
            return
        key = month_key(organization_id)
        result = await _incr_if_within(client, key, estimate, limit, 31 * 86400)
        if result < 0:
            used = await _usage(client, key)
            raise QuotaExceededError(
                f"本月 token 预算已用尽（{used}/{limit}），本次调用已被阻止。"
            )
    finally:
        await client.aclose()


async def reserve_cost(
    organization_id: str | None,
    *,
    estimate_cny: float,
) -> None:
    """原子预占成本（毫元粒度）；超出月度成本预算时硬阻断。"""
    if not organization_id or estimate_cny <= 0:
        return
    client = _redis()
    try:
        limit_cny = await _effective_cost_limit_cny(client, organization_id)
        if limit_cny <= 0:
            return
        key = cost_key(organization_id)
        limit_milli = int(limit_cny * 1000)
        result = await _incr_if_within(
            client, key, int(estimate_cny * 1000), limit_milli, 31 * 86400
        )
        if result < 0:
            used_milli = await _usage(client, key)
            raise QuotaExceededError(
                f"本月成本预算已用尽（{used_milli / 1000:.3f}/{limit_cny:.3f} CNY），"
                "本次调用已被阻止。"
            )
    finally:
        await client.aclose()


async def settle_cost(
    organization_id: str | None,
    *,
    estimate_cny: float,
    actual_cny: float,
) -> None:
    if not organization_id:
        return
    client = _redis()
    try:
        limit_cny = await _effective_cost_limit_cny(client, organization_id)
        if limit_cny <= 0:
            return
        key = cost_key(organization_id)
        delta = int(actual_cny * 1000) - int(estimate_cny * 1000)
        if delta != 0:
            await client.incrby(key, delta)
            await client.expire(key, 31 * 86400)
    finally:
        await client.aclose()


async def settle_tokens(
    organization_id: str | None,
    *,
    estimate: int,
    actual: int,
) -> None:
    """结算：按真实用量修正预占（多退少补，可负）。"""
    if not organization_id:
        return
    client = _redis()
    try:
        limit = await _effective_token_limit(client, organization_id)
        if limit <= 0:
            return
        key = month_key(organization_id)
        delta = max(0, actual) - max(0, estimate)
        if delta != 0:
            await client.incrby(key, delta)
            await client.expire(key, 31 * 86400)
    finally:
        await client.aclose()


async def acquire_llm_slot(organization_id: str | None) -> bool:
    """并发闸门：占一个模型调用槽位；超限返回 False（调用方转为错误）。"""
    if not organization_id:
        return True
    client = _redis()
    try:
        limit = await _effective_concurrent_limit(client, organization_id)
        if limit <= 0:
            return True
        key = f"quota:concurrent:{organization_id}"
        result = await _incr_if_within(client, key, 1, limit, 300)
        return result >= 0
    finally:
        await client.aclose()


async def release_llm_slot(organization_id: str | None) -> None:
    if not organization_id:
        return
    client = _redis()
    try:
        key = f"quota:concurrent:{organization_id}"
        current = int(await client.get(key) or 0)
        if current > 0:
            await client.decr(key)
            await client.expire(key, 300)
    finally:
        await client.aclose()


async def quota_usage(organization_id: str | None) -> dict[str, Any]:
    """当前租户配额用量（只读）。"""
    client = _redis()
    try:
        tokens = (
            await _usage(client, month_key(organization_id)) if organization_id else 0
        )
        cost_cny = (
            float(await _usage(client, cost_key(organization_id))) / 1000.0
            if organization_id
            else None
        )
        concurrent = (
            int(await client.get(f"quota:concurrent:{organization_id}") or 0)
            if organization_id
            else 0
        )
        token_limit = (
            await _effective_token_limit(client, organization_id)
            if organization_id
            else _monthly_token_limit()
        )
        cost_limit_cny = (
            await _effective_cost_limit_cny(client, organization_id)
            if organization_id
            else _monthly_cost_limit_cny()
        )
        concurrent_limit = (
            await _effective_concurrent_limit(client, organization_id)
            if organization_id
            else _concurrent_limit()
        )
    finally:
        await client.aclose()
    return {
        "organization_id": organization_id,
        "monthly_token_used": tokens,
        "monthly_token_budget": token_limit,
        "monthly_cost_used_cny": cost_cny,
        "monthly_cost_budget_cny": cost_limit_cny,
        "concurrent_llm_calls": concurrent,
        "concurrent_llm_limit": concurrent_limit,
        "month": datetime.now(timezone.utc).strftime("%Y-%m"),
    }


def estimate_tokens_for_messages(messages: list[Any]) -> int:
    from app.core.context_policy import estimate_message_tokens

    return estimate_message_tokens(messages)


__all__ = [
    "QuotaExceededError",
    "acquire_llm_slot",
    "check_token_budget",
    "estimate_tokens_for_messages",
    "month_key",
    "quota_usage",
    "release_llm_slot",
    "reserve_cost",
    "reserve_tokens",
    "set_quota_limits",
    "settle_cost",
    "settle_tokens",
]
