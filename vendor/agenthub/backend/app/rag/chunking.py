"""文档分块策略（RAG 最小单元）。"""

from __future__ import annotations


def split_text(
    text: str,
    *,
    chunk_size: int = 800,
    chunk_overlap: int = 100,
) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = max(start + 1, end - chunk_overlap)
    return chunks


__all__ = ["split_text"]
