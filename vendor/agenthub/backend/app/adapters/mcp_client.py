"""Admin-configured read-only MCP connectors, always bridged through ToolExecutor.

Each entry binds a tenant, streamable_http URL, and an explicit readonly_tools allowlist.
No model-provided URLs/credentials, no remote write tools or shell transports.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time

from langchain_core.tools import StructuredTool

from app.config import settings
from app.engine.tool_registry import register_tool

_cache: dict[str, tuple[float, list]] = {}


def make_handler(target, tenant, server_name, server_url):
    async def handler(params, organization_id):
        from app.engine.delivery_tools import tool_identity

        await tool_identity(organization_id)
        if str(organization_id) != tenant:
            raise PermissionError("Connector tenant permission denied")
        entries = json.loads(settings.MCP_CONNECTORS_JSON)
        if not any(
            isinstance(entry, dict)
            and str(entry.get("organization_id")) == tenant
            and entry.get("name") == server_name
            and entry.get("url") == server_url
            and target.name in (entry.get("readonly_tools") or [])
            for entry in entries
        ):
            raise PermissionError("Connector no longer authorized")
        try:
            data = await target.ainvoke(params)
            return {"status": "success", "data": data, "error": None}
        except Exception:  # noqa: BLE001 - remote errors can contain credentials
            # Remote errors may include credential-bearing endpoints.
            return {
                "status": "failed",
                "data": None,
                "error": "连接器未返回可用结果，请管理员检查连接与授权。",
            }

    return handler


async def connector_tools(organization_id):
    key = str(organization_id)
    cached = _cache.get(key)
    if cached and cached[0] > time.monotonic():
        return cached[1], []
    tools, blockers = [], []
    try:
        entries = json.loads(settings.MCP_CONNECTORS_JSON)
        if not isinstance(entries, list):
            raise TypeError("Connector config must be a list")
    except (ValueError, TypeError):
        return [], [
            {
                "code": "connector_configuration",
                "reason": "工具连接配置格式无效。",
                "next_actions": ["请管理员检查 MCP 连接配置。"],
            }
        ]
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("organization_id")) != key:
            continue
        name = str(entry.get("name") or "")
        if not re.fullmatch(r"[a-zA-Z0-9_]{1,32}", name) or not str(
            entry.get("url") or ""
        ).startswith("https://"):
            blockers.append(
                {
                    "code": "connector_configuration",
                    "reason": "连接器名称或 HTTPS 地址无效。",
                    "next_actions": ["请管理员修正连接器配置。"],
                }
            )
            continue
        try:
            from langchain_mcp_adapters.client import MultiServerMCPClient

            client = MultiServerMCPClient(
                {
                    name: {
                        "transport": "streamable_http",
                        "url": entry["url"],
                        "headers": entry.get("headers") or {},
                    }
                }
            )
            remote_tools = await asyncio.wait_for(client.get_tools(), timeout=15)
            allowed = set(entry.get("readonly_tools") or [])
            for remote in remote_tools:
                if remote.name not in allowed:
                    continue
                tenant_tag = hashlib.sha256(key.encode()).hexdigest()[:8]
                remote_tag = hashlib.sha256(remote.name.encode()).hexdigest()[:6]
                exported_name = (
                    f"mcp_{tenant_tag}_{name[:12]}_{remote.name[:20]}_{remote_tag}"
                )
                if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", exported_name):
                    continue
                schema = (
                    remote.args_schema
                    if isinstance(remote.args_schema, dict)
                    else remote.args_schema.model_json_schema()
                )

                handler = make_handler(remote, key, name, entry["url"])
                register_tool(
                    exported_name,
                    remote.description,
                    schema,
                    handler,
                    organization_id=key,
                    timeout=30,
                )
                tools.append(
                    StructuredTool.from_function(
                        coroutine=handler,
                        name=exported_name,
                        description=remote.description,
                        args_schema=schema,
                    )
                )
        except Exception:  # noqa: BLE001 - redact remote errors
            blockers.append(
                {
                    "code": "connector_unavailable",
                    "reason": f"连接器 {name} 暂不可用。",
                    "next_actions": [
                        "请管理员检查连接器服务和认证配置，再继续相关任务。"
                    ],
                }
            )
    if not blockers:
        _cache[key] = (time.monotonic() + 60, tools)
    return tools, blockers
