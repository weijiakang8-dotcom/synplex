"""多 Agent 体系：注册表 + 自更新管线。"""

from app.agents.registry import (
    DEFAULT_AGENTS,
    AgentSpec,
    get_active_version,
    get_agent_spec,
    get_prompt,
    list_agent_specs,
)

__all__ = [
    "DEFAULT_AGENTS",
    "AgentSpec",
    "get_active_version",
    "get_agent_spec",
    "get_prompt",
    "list_agent_specs",
]
