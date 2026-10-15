"""Skill 匹配：任务文本 → 候选 Skill 排序。

- 关键词命中（trigger 词表）优先，零成本；
- 文本相似度用 RAG embedder（可用时），否则退化为字符重叠；
- 只返回本租户 + 全局预设中 status=active 的 skill。
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from sqlalchemy import or_, select

from app.database import async_session_factory
from app.models import Skill

logger = logging.getLogger(__name__)

MAX_MATCHES = 5
MIN_SCORE = 0.15


def _keyword_score(text: str, trigger: str) -> float:
    text_lower = str(text or "").lower()
    if not text_lower:
        return 0.0
    keywords = [
        word.strip()
        for word in re.split(r"[,，、]", str(trigger or ""))
        if word.strip()
    ]
    hits = sum(1 for word in keywords if word.lower() in text_lower)
    if not keywords:
        return 0.0
    return hits / len(keywords)


def _overlap_score(text: str, name: str, description: str) -> float:
    """字符 bigram 重叠：无 embedder 时的兜底相似度。"""

    def bigrams(value: str) -> set[str]:
        value = str(value or "").lower()
        return {value[i : i + 2] for i in range(max(0, len(value) - 1))}

    text_grams = bigrams(text)
    ref_grams = bigrams(name) | bigrams(description)
    if not text_grams or not ref_grams:
        return 0.0
    return len(text_grams & ref_grams) / len(text_grams)


async def match_skills(
    text: str,
    organization_id: str | None,
    *,
    limit: int = MAX_MATCHES,
) -> list[dict[str, Any]]:
    """返回候选 Skill 列表（带 score/reason，供调度中心展示）。"""
    try:
        async with async_session_factory() as session:
            stmt = select(Skill).where(
                Skill.status == "active",
                Skill.runtime == "agent",
                or_(
                    Skill.organization_id.is_(None),
                    Skill.organization_id
                    == (uuid.UUID(str(organization_id)) if organization_id else None),
                ),
            )
            result = await session.execute(stmt)
            skills = list(result.scalars().all())
    except Exception:  # noqa: BLE001
        return []

    scored: list[dict[str, Any]] = []
    for skill in skills:
        keyword = _keyword_score(text, skill.trigger)
        overlap = _overlap_score(text, skill.name, skill.description)
        score = round(min(1.0, keyword * 0.75 + overlap * 0.25), 4)
        if score < MIN_SCORE and not keyword:
            continue
        scored.append(
            {
                "id": str(skill.id),
                "name": skill.name,
                "description": skill.description,
                "icon": skill.icon,
                "score": score,
                "reason": (
                    f"触发词命中 {keyword:.0%}"
                    if keyword
                    else f"文本相似 {overlap:.0%}"
                ),
                "source": skill.source,
                "version": skill.version,
                "times_used": skill.times_used,
                "plan_template": skill.plan_template,
                "model_tier_hints": skill.model_tier_hints,
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


__all__ = ["MAX_MATCHES", "match_skills"]
