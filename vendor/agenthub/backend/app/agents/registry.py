"""多 Agent 注册表（调度中心自带 Agent 阵容）。

每个 Agent 有默认提示词与模型档位策略；租户可通过 AgentVersion 覆盖
（自更新产物）。get_prompt 读取"默认 + 本租户最新 active 版本"。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select

from app.database import async_session_factory
from app.models import AgentVersion

DEFAULT_AGENTS: dict[str, dict[str, Any]] = {
    "dispatcher": {
        "role": "调度 Agent：组装上下文、展示执行方案、发起澄清，不直接拍板路由",
        "system_prompt": (
            "你是调度 Agent。把任务的执行方案组织得清晰可读："
            "目标、步骤、每步为什么这么安排、预计成本。"
            "遇到表述歧义时，生成 2-4 个互斥的语义选项让用户选择，"
            "不要替用户猜测语义。"
        ),
        "model_policy": {"default_complexity": "simple"},
    },
    "planner": {
        "role": "规划 Agent：把目标拆成 1-6 步能力计划",
        "system_prompt": (
            "你是规划 Agent。把目标拆成可执行步骤，优先复用已有技能骨架，"
            "简单任务只输出一个 answer 步骤。"
        ),
        "model_policy": {"default_complexity": "complex"},
    },
    "executor": {
        "role": "执行 Agent：按步骤调用工具并合成结果",
        "system_prompt": ("你是执行 Agent。只依据工具结果与已提供证据回答，不编造。"),
        "model_policy": {"default_complexity": "simple"},
    },
    "verifier": {
        "role": "验证 Agent：检查输出是否满足用户输入（跨模型交叉验证）",
        "system_prompt": (
            "你是质量审查员。检查下面的 Agent 输出是否完整满足用户输入。"
            "只允许输出 PASS 或 FAIL 两个单词，不要输出任何其他内容。"
        ),
        "model_policy": {"default_complexity": "simple", "cross_model": True},
    },
    "clarifier": {
        "role": "澄清 Agent：为歧义表述生成候选语义选项",
        "system_prompt": (
            "你是澄清 Agent。针对歧义，输出 2-4 个互斥、具体、可直接执行的选项。"
            '只输出 JSON：{"question":"<一句话问题>","options":["选项1","选项2"]}'
        ),
        "model_policy": {"default_complexity": "simple"},
    },
    "billing": {
        "role": "记账 Agent：汇总成本、生成省钱账单摘要",
        "system_prompt": (
            "你是记账 Agent。用数据说话：实际成本、基线成本、节省金额与占比。"
        ),
        "model_policy": {"default_complexity": "simple"},
    },
}


@dataclass(frozen=True)
class AgentSpec:
    name: str
    role: str
    system_prompt: str
    model_policy: dict[str, Any] = field(default_factory=dict)


def get_agent_spec(name: str) -> AgentSpec | None:
    entry = DEFAULT_AGENTS.get(name)
    if entry is None:
        return None
    return AgentSpec(
        name=name,
        role=entry["role"],
        system_prompt=entry["system_prompt"],
        model_policy=entry["model_policy"],
    )


def list_agent_specs() -> list[AgentSpec]:
    return [get_agent_spec(name) for name in DEFAULT_AGENTS if get_agent_spec(name)]


async def get_active_version(
    name: str, organization_id: str | None
) -> AgentVersion | None:
    """本租户最新 active 版本（自更新覆盖默认提示词）。"""
    try:
        async with async_session_factory() as session:
            stmt = (
                select(AgentVersion)
                .where(
                    AgentVersion.name == name,
                    AgentVersion.status == "active",
                )
                .order_by(AgentVersion.version.desc())
                .limit(1)
            )
            if organization_id:
                stmt = stmt.where(
                    AgentVersion.organization_id == uuid.UUID(str(organization_id))
                )
            result = await session.execute(stmt)
            return result.scalars().first()
    except Exception:  # noqa: BLE001
        return None


async def get_prompt(name: str, organization_id: str | None) -> str:
    """Agent 生效提示词：租户 active 版本 > 默认。"""
    version = await get_active_version(name, organization_id)
    if version is not None and version.system_prompt:
        return version.system_prompt
    spec = get_agent_spec(name)
    return spec.system_prompt if spec else ""


__all__ = [
    "DEFAULT_AGENTS",
    "AgentSpec",
    "get_active_version",
    "get_agent_spec",
    "get_prompt",
    "list_agent_specs",
]
