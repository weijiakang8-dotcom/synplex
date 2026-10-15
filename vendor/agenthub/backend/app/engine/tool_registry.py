from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Awaitable[dict[str, Any]]]
    timeout: float = 30.0
    requires_approval: bool = False
    # 副作用属性：true = claim 后 provider 调用最多一次，禁止自动 retry。
    # 与 Capability.side_effect 同源；在工具边界显式化，避免重复 capability 体系。
    side_effect: bool = False
    organization_id: str | None = None


_registry: dict[str, ToolSpec] = {}


def register_tool(
    name: str,
    description: str,
    parameters: dict[str, Any],
    handler: Callable[..., Awaitable[dict[str, Any]]],
    *,
    timeout: float = 30.0,
    requires_approval: bool = False,
    side_effect: bool = False,
    organization_id: str | None = None,
) -> None:
    """注册或覆盖一个工具。"""
    if not name:
        raise ValueError("Tool name cannot be empty")
    _registry[name] = ToolSpec(
        name=name,
        description=description,
        parameters=parameters,
        handler=handler,
        timeout=timeout,
        requires_approval=requires_approval,
        side_effect=side_effect,
        organization_id=organization_id,
    )


def unregister_tool(name: str) -> bool:
    """注销工具，返回是否成功。"""
    return _registry.pop(name, None) is not None


def get_tool(name: str) -> ToolSpec | None:
    return _registry.get(name)


def list_tools(*, organization_id=None) -> list[dict[str, Any]]:
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.parameters,
            "timeout": spec.timeout,
            "requires_approval": spec.requires_approval,
        }
        for spec in _registry.values()
        if spec.organization_id is None or spec.organization_id == str(organization_id)
    ]


def register_builtin_tools() -> None:
    """注册内置工具，幂等。"""
    from app.engine import tools as builtin_tools

    async def _search_web(params, organization_id=None, user_id=None):
        return await builtin_tools.search_web.ainvoke(params)

    async def _query_db(params, organization_id=None, user_id=None):
        return await builtin_tools.run_query_db(params.get("sql", ""), organization_id)

    async def _search_knowledge(params, organization_id=None, user_id=None):
        return await builtin_tools.run_search_knowledge(
            params.get("query", ""),
            organization_id,
            top_k=params.get("top_k", 5),
        )

    async def _recall_memory(params, organization_id=None, user_id=None):
        return await builtin_tools.run_recall_memory(
            params.get("query", ""),
            organization_id,
            user_id=user_id,
            top_k=params.get("top_k", 3),
        )

    async def _recall_executions(params, organization_id=None, user_id=None):
        return await builtin_tools.run_recall_executions(
            organization_id,
            user_id=user_id,
            limit=params.get("limit", 5),
        )

    async def _send_email(params, organization_id=None, user_id=None):
        return await builtin_tools.send_email.ainvoke(params)

    register_tool(
        "search_web",
        "Search the web and return result summaries.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
        _search_web,
        timeout=15.0,
        requires_approval=False,
    )
    register_tool(
        "query_db",
        "Run a single read-only SQL SELECT query.",
        {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "A read-only SELECT query"},
            },
            "required": ["sql"],
        },
        _query_db,
        timeout=30.0,
        requires_approval=False,
    )
    register_tool(
        "search_knowledge",
        "Search the tenant knowledge base (RAG) and return relevant chunks.",
        {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of chunks to return (1-10)",
                    "minimum": 1,
                    "maximum": 10,
                },
            },
            "required": ["query"],
        },
        _search_knowledge,
        timeout=30.0,
        requires_approval=False,
    )
    register_tool(
        "recall_memory",
        "Recall the current user's long-term memory entries relevant to the query.",
        {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to recall",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of memories to return (1-10)",
                    "minimum": 1,
                    "maximum": 10,
                },
            },
            "required": ["query"],
        },
        _recall_memory,
        timeout=30.0,
        requires_approval=False,
    )
    register_tool(
        "recall_executions",
        "Recall recent completed executions for the current tenant/user.",
        {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Number of executions to return (1-10)",
                    "minimum": 1,
                    "maximum": 10,
                }
            },
            "required": [],
        },
        _recall_executions,
        timeout=30.0,
        requires_approval=False,
    )
    register_tool(
        "send_email",
        "Send an email via SMTP. Requires human approval.",
        {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
        _send_email,
        timeout=30.0,
        requires_approval=True,
        side_effect=True,
    )

    from app.engine.delivery_tools import register_delivery_tools

    register_delivery_tools()


register_builtin_tools()
