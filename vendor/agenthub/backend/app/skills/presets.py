"""预设 Skill 包（WorkBuddy 式：常用任务开箱即用）。

plan_template 使用 agent runtime 计划骨架（goal/risk/steps），
能力名必须来自 app.engine.capabilities.CAPABILITIES。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from app.database import async_session_factory
from app.models import Skill

logger = logging.getLogger(__name__)


def _steps(capabilities: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "step_id": f"step_{index + 1}",
            "capability": capability,
            "description": capability,
        }
        for index, capability in enumerate(capabilities)
    ]


PRESET_SKILLS: list[dict[str, Any]] = [
    {
        "name": "行业研究报告",
        "icon": "trending-up",
        "description": "调研一个行业/主题，产出带来源的结构化研究报告",
        "trigger": "研究、调研、行业分析、趋势、报告",
        "plan": {
            "goal": "产出一份行业/主题研究报告",
            "risk": "HIGH",
            "steps": _steps(["research", "analysis", "answer"]),
        },
        "tier_hints": {
            "research": "simple",
            "analysis": "complex",
            "answer": "complex",
        },
    },
    {
        "name": "竞品分析",
        "icon": "swords",
        "description": "对比竞品的产品/价格/卖点，输出可读的竞品分析",
        "trigger": "竞品、对手、对比、benchmark",
        "plan": {
            "goal": "产出竞品对比分析",
            "risk": "HIGH",
            "steps": _steps(["research", "research", "analysis", "answer"]),
        },
        "tier_hints": {
            "research": "simple",
            "analysis": "complex",
            "answer": "complex",
        },
    },
    {
        "name": "每周周报",
        "icon": "calendar-days",
        "description": "把本周素材整理成结构化周报",
        "trigger": "周报、总结、汇报、weekly",
        "plan": {
            "goal": "整理本周工作为周报",
            "risk": "MEDIUM",
            "steps": _steps(["analysis", "answer"]),
        },
        "tier_hints": {"analysis": "complex", "answer": "complex"},
    },
    {
        "name": "数据问答",
        "icon": "database",
        "description": "对本平台数据库做只读查询并回答统计问题",
        "trigger": "多少、统计、数量、查询数据库、count",
        "plan": {
            "goal": "用只读查询回答数据问题",
            "risk": "MEDIUM",
            "steps": _steps(["query_db", "analysis", "answer"]),
        },
        "tier_hints": {"query_db": "simple", "analysis": "complex", "answer": "simple"},
    },
    {
        "name": "文档总结",
        "icon": "file-text",
        "description": "总结知识库文档/长文本的要点",
        "trigger": "总结、摘要、要点、太长不看",
        "plan": {
            "goal": "输出要点总结",
            "risk": "LOW",
            "steps": _steps(["knowledge", "answer"]),
        },
        "tier_hints": {"knowledge": "simple", "answer": "simple"},
    },
    {
        "name": "翻译润色",
        "icon": "languages",
        "description": "翻译或润色文本",
        "trigger": "翻译、润色、改写、polish",
        "plan": {
            "goal": "输出翻译/润色后的文本",
            "risk": "LOW",
            "steps": _steps(["answer"]),
        },
        "tier_hints": {"answer": "complex"},
    },
    {
        "name": "通知起草",
        "icon": "megaphone",
        "description": "起草对外通知/公告（发送前需审批）",
        "trigger": "通知、公告、发给、群发、邮件",
        "plan": {
            "goal": "起草并（审批后）发送通知",
            "risk": "SIDE_EFFECT",
            "steps": _steps(["analysis", "send_email"]),
        },
        "tier_hints": {"analysis": "complex", "send_email": "complex"},
    },
    {
        "name": "选题策划",
        "icon": "lightbulb",
        "description": "围绕主题产出内容选题与角度清单",
        "trigger": "选题、点子、角度、灵感、策划",
        "plan": {
            "goal": "输出选题清单",
            "risk": "MEDIUM",
            "steps": _steps(["research", "analysis", "answer"]),
        },
        "tier_hints": {
            "research": "simple",
            "analysis": "complex",
            "answer": "complex",
        },
    },
]


async def ensure_preset_skills() -> int:
    """幂等播种预设 Skill（organization_id=None 即全局预设）。返回新增数量。"""
    created = 0
    try:
        async with async_session_factory() as session:
            result = await session.execute(
                select(Skill).where(
                    Skill.organization_id.is_(None), Skill.source == "preset"
                )
            )
            existing_names = {skill.name for skill in result.scalars().all()}
            for preset in PRESET_SKILLS:
                if preset["name"] in existing_names:
                    continue
                session.add(
                    Skill(
                        name=preset["name"],
                        description=preset["description"],
                        goal={"summary": preset["plan"]["goal"]},
                        plan_template=preset["plan"],
                        icon=preset["icon"],
                        organization_id=None,
                        created_by=None,
                        source="preset",
                        version=1,
                        status="active",
                        runtime="agent",
                        trigger=preset["trigger"],
                        model_tier_hints=preset["tier_hints"],
                    )
                )
                created += 1
            await session.commit()
    except Exception:
        logger.warning("ensure_preset_skills failed", exc_info=True)
    return created


__all__ = ["PRESET_SKILLS", "ensure_preset_skills"]
