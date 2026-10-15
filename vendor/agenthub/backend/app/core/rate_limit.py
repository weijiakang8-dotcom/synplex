from __future__ import annotations

import logging
import time

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)


async def rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    """固定窗口限流。返回 True 表示允许，False 表示超出限制。"""
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        bucket = f"rate:{key}:{int(time.time() // window_seconds)}"
        count = await client.incr(bucket)
        if count == 1:
            await client.expire(bucket, window_seconds)
        return count <= limit
    except Exception:
        logger.warning("Redis rate limit unavailable; degrading open", exc_info=True)
        return True
    finally:
        try:
            await client.aclose()
        except Exception:
            logger.debug("Failed to close Redis rate-limit client", exc_info=True)
