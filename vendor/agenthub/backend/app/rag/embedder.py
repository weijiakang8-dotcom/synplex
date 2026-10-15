from __future__ import annotations

import asyncio
import hashlib
import math
import re
from typing import Any

import httpx

from app.config import settings

_model: Any = None


def _hash_embed(text: str, dims: int = 384) -> list[float]:
    vec = [0.0] * dims
    tokens = re.findall(r"[a-zA-Z0-9\u4e00-\u9fff]+", text.lower())
    for i in range(len(tokens)):
        for n in (1, 2, 3):
            gram = " ".join(tokens[i : i + n])
            idx = (
                int.from_bytes(hashlib.md5(gram.encode()).digest()[:4], "little") % dims
            )
            vec[idx] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def _load_model() -> Any:
    global _model
    if _model is not None:
        return _model
    try:
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
        )
    except Exception:  # noqa: BLE001
        _model = False
    return _model


async def embed_text(text: str) -> list[float]:
    if settings.EMBEDDING_PROVIDER == "ollama":
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{settings.EMBEDDING_BASE_URL}/api/embed",
                json={"model": settings.EMBEDDING_MODEL, "input": text},
            )
            response.raise_for_status()
            data = response.json()
        embeddings = data.get("embeddings") or []
        if not embeddings:
            raise RuntimeError("Ollama embedding response is empty")
        vector = [float(value) for value in embeddings[0]]
        if len(vector) != settings.EMBEDDING_DIMENSION:
            raise RuntimeError(
                f"Ollama embedding dimension mismatch: "
                f"expected {settings.EMBEDDING_DIMENSION}, got {len(vector)}"
            )
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    if settings.EMBEDDING_PROVIDER == "hash":
        return _hash_embed(text, dims=settings.EMBEDDING_DIMENSION)

    # SentenceTransformer 模型加载是网络/CPU 密集操作，必须移出事件循环；
    # 加载失败时降级为确定性的哈希向量，保证 RAG 永不阻塞主链路。
    try:
        model = await asyncio.wait_for(asyncio.to_thread(_load_model), timeout=15)
    except Exception:  # noqa: BLE001
        model = False
    if model is False:
        return _hash_embed(text, dims=settings.EMBEDDING_DIMENSION)
    vectors = await asyncio.wait_for(
        asyncio.to_thread(model.encode, [text]), timeout=15
    )
    vector = vectors[0].tolist() if hasattr(vectors[0], "tolist") else list(vectors[0])
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    return sum(x * y for x, y in zip(a, b))
