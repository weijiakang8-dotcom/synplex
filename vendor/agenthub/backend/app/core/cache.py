from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import redis.asyncio as aioredis
from prometheus_client import Counter

from app.config import settings

logger = logging.getLogger(__name__)

CACHE_HITS = Counter("cache_hits_total", "Semantic cache hits")
CACHE_MISSES = Counter("cache_misses_total", "Semantic cache misses")
TOKENS_SAVED = Counter("tokens_saved_total", "Estimated tokens saved by semantic cache")

_CACHE_KEY = "agenthub:semantic_cache"
_MAX_ENTRIES = 500
_CACHE_TTL_SECONDS = 24 * 60 * 60

# Semantic cache is an OPTIONAL performance optimization.  When the embedding
# path is unavailable it must fail open (cache miss) instead of blocking core
# RAG + LLM execution.  SEMANTIC_CACHE_ENABLED defaults to enabled so existing
# deployments keep current behavior unless explicitly disabled.
_SEMANTIC_CACHE_ENABLED = os.getenv(
    "SEMANTIC_CACHE_ENABLED", "true"
).strip().lower() not in {"0", "false", "no", "off"}

# Model loading and encoding are CPU/network bound, so they run in a bounded
# thread pool with an explicit timeout per step.  A timed-out step is reported
# as a cache miss; the worker thread is never allowed to hold up the event loop.
_EMBED_TIMEOUT_SECONDS = max(
    0.05, float(os.getenv("SEMANTIC_CACHE_EMBED_TIMEOUT_SECONDS", "5"))
)
_EMBED_MAX_WORKERS = max(1, int(os.getenv("SEMANTIC_CACHE_EMBED_WORKERS", "2")))

_EMBED_EXECUTOR = ThreadPoolExecutor(
    max_workers=_EMBED_MAX_WORKERS,
    thread_name_prefix="semantic_cache_embed",
)

_model = None
_model_lock = threading.Lock()


def _cache_key(organization_id) -> str:
    namespace = str(organization_id) if organization_id is not None else "global"
    return f"{_CACHE_KEY}:{namespace}"


def _load_model():
    """Load the sentence-transformer model once, off the event loop."""

    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer("all-MiniLM-L6-v2")
        return _model


async def _run_embedding_step(fn, *args):
    """Run one blocking embedding step in the bounded executor with a timeout."""

    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(_EMBED_EXECUTOR, fn, *args)
    return await asyncio.wait_for(future, timeout=_EMBED_TIMEOUT_SECONDS)


async def _embed(text: str) -> list[float] | None:
    """Return a normalized embedding, or None on timeout/exception (fail open)."""

    try:
        model = await _run_embedding_step(_load_model)
        vectors = await _run_embedding_step(model.encode, [text])
        vector = (
            vectors[0].tolist() if hasattr(vectors[0], "tolist") else list(vectors[0])
        )
        norm = math.sqrt(sum(x * x for x in vector)) or 1.0
        return [x / norm for x in vector]
    except TimeoutError:
        logger.warning(
            "Semantic cache embedding timed out after %.2fs; cache miss",
            _EMBED_TIMEOUT_SECONDS,
        )
        return None
    except Exception:
        logger.warning(
            "Semantic cache embedding unavailable; cache miss", exc_info=True
        )
        return None


def _redis() -> aioredis.Redis:
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


async def get_cached_response(
    query: str,
    *,
    organization_id=None,
    model: str | None = None,
    context_digest: str | None = None,
    threshold: float = 0.85,
) -> str | None:
    if not query or not _SEMANTIC_CACHE_ENABLED:
        return None

    embedding = await _embed(query)
    if embedding is None:
        CACHE_MISSES.inc()
        return None

    client = _redis()
    org_str = str(organization_id) if organization_id is not None else None
    try:
        try:
            entries = await client.lrange(_cache_key(organization_id), 0, -1)
        except Exception:
            logger.warning(
                "Redis semantic cache unavailable; cache miss", exc_info=True
            )
            CACHE_MISSES.inc()
            return None
        best: tuple[float, dict[str, Any]] | None = None
        for raw in entries:
            try:
                item = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if item.get("organization_id") != org_str:
                continue
            if item.get("model") != model:
                continue
            if item.get("context_digest") != context_digest:
                continue
            cosine = sum(a * b for a, b in zip(embedding, item.get("embedding", [])))
            if best is None or cosine > best[0]:
                best = (cosine, item)

        if best is not None and best[0] >= threshold:
            CACHE_HITS.inc()
            TOKENS_SAVED.inc(500)
            return best[1]["response"]

        CACHE_MISSES.inc()
        return None
    finally:
        try:
            await client.aclose()
        except Exception:
            logger.debug("Failed to close Redis cache client", exc_info=True)


async def set_cached_response(
    query: str,
    response: str,
    *,
    organization_id=None,
    model: str | None = None,
    context_digest: str | None = None,
) -> None:
    if not query or not response or not _SEMANTIC_CACHE_ENABLED:
        return

    embedding = await _embed(query)
    if embedding is None:
        # Embedding unavailable: skip the write. Never raise into core execution.
        return

    client = _redis()
    key = _cache_key(organization_id)
    try:
        try:
            await client.rpush(
                key,
                json.dumps(
                    {
                        "query": query,
                        "response": response,
                        "embedding": embedding,
                        "organization_id": (
                            str(organization_id)
                            if organization_id is not None
                            else None
                        ),
                        "model": model,
                        "context_digest": context_digest,
                    },
                    ensure_ascii=False,
                ),
            )
            await client.ltrim(key, -_MAX_ENTRIES, -1)
            await client.expire(key, _CACHE_TTL_SECONDS)
        except Exception:
            logger.warning("Redis semantic cache write unavailable", exc_info=True)
    finally:
        try:
            await client.aclose()
        except Exception:
            logger.debug("Failed to close Redis cache client", exc_info=True)
