"""AgentHub MCP（Model Context Protocol）服务器。

把平台"调度中心"的能力以 MCP 工具的形式暴露给外部 AI 客户端
（Claude / Codex / ChatGPT 桌面等），让外部助手把 AgentHub 当插件调用。

v1 实现约束：
- JSON-RPC 2.0，仅支持 HTTP POST；
- Streamable-HTTP 风格：客户端即使带 ``Accept: application/json,
  text/event-stream`` 也一律返回 JSON（不做 SSE 流）；
- 认证复用 ``CurrentUserDep``（Bearer JWT），未认证返回 401；
- 所有内部调用 try/except：出错返回 ``isError: true`` 而非 500。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app.api.deps import CurrentUserDep, SessionDep
from app.core.complexity import score_task
from app.core.routing import model_candidates, normalize_tier
from app.core.savings import latest_savings, token_dashboard
from app.skills.matching import match_skills

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp", tags=["mcp"])

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO: dict[str, str] = {"name": "agenthub", "version": "0.1.0"}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "agenthub.analyze_task",
        "description": (
            "分析任务复杂度并给出 Skill 匹配与模型候选。"
            "纯规则、零 LLM 成本，不执行任务。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "input": {"type": "string", "description": "任务描述文本"},
                "tier": {
                    "type": "string",
                    "enum": ["economy", "balanced", "quality"],
                    "description": "成本档位（可选，默认 balanced）",
                },
            },
            "required": ["input"],
        },
    },
    {
        "name": "agenthub.match_skills",
        "description": "根据任务文本匹配候选 Skill 列表（触发词 + 文本相似）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "input": {"type": "string", "description": "任务描述文本"},
            },
            "required": ["input"],
        },
    },
    {
        "name": "agenthub.savings_report",
        "description": "获取最近一期省钱账单与 token 看板（无数据时返回空说明）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "agenthub.health",
        "description": "检查 AgentHub 服务与数据库健康状态。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class JsonRpcRequest(BaseModel):
    """JSON-RPC 2.0 请求体（宽松解析，容忍未知字段）。"""

    model_config = ConfigDict(extra="allow")

    jsonrpc: str = "2.0"
    id: Any = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


def _rpc_result(request_id: Any, result: Any) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})


def _rpc_error(request_id: Any, code: int, message: str) -> JSONResponse:
    return JSONResponse(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
    )


def _tool_result(result: Any, *, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
        "isError": is_error,
    }


async def _call_analyze_task(user: Any, arguments: dict[str, Any]) -> dict[str, Any]:
    """复杂度评分 + Skill 匹配 + 模型候选（零 LLM 成本，纯规则）。"""
    user_input = str(arguments.get("input") or "")
    tier = normalize_tier(arguments.get("tier"))
    org_id = str(user.organization_id) if user.organization_id else None

    task_score = score_task(user_input)

    skills: list[Any] = []
    try:
        skills = await match_skills(user_input, org_id)
    except Exception:
        logger.warning("MCP analyze: match_skills failed", exc_info=True)

    candidates: list[str] = []
    try:
        candidates = await model_candidates(org_id)
    except Exception:
        logger.warning("MCP analyze: model_candidates failed", exc_info=True)

    return {
        "complexity": task_score.to_dict(),
        "tier": tier,
        "skills": skills,
        "candidates": candidates,
    }


async def _call_match_skills(user: Any, arguments: dict[str, Any]) -> list[Any]:
    user_input = str(arguments.get("input") or "")
    org_id = str(user.organization_id) if user.organization_id else None
    return await match_skills(user_input, org_id)


async def _call_savings_report(user: Any) -> dict[str, Any]:
    org_id = str(user.organization_id) if user.organization_id else None
    report = await latest_savings(org_id)
    dashboard = await token_dashboard(org_id)
    if report is None:
        return {
            "available": False,
            "message": "暂无省钱账单数据（系统会按周期自动生成）",
            "dashboard": dashboard,
        }
    return {"available": True, "savings": report, "dashboard": dashboard}


async def _call_health(session: Any) -> dict[str, Any]:
    database = False
    try:
        await session.execute(text("SELECT 1"))
        database = True
    except Exception:
        logger.warning("MCP health: database check failed", exc_info=True)
    return {"service": "agenthub", "database": database}


async def _dispatch_tool_call(
    user: Any, session: Any, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    try:
        if name == "agenthub.analyze_task":
            return _tool_result(await _call_analyze_task(user, arguments))
        if name == "agenthub.match_skills":
            return _tool_result(await _call_match_skills(user, arguments))
        if name == "agenthub.savings_report":
            return _tool_result(await _call_savings_report(user))
        if name == "agenthub.health":
            return _tool_result(await _call_health(session))
        return _tool_result({"error": f"Unknown tool: {name}"}, is_error=True)
    except Exception:
        logger.exception("MCP tools/call failed for %s", name)
        return _tool_result(
            {"error": f"Internal error while calling {name}"}, is_error=True
        )


@router.post("")
async def mcp_endpoint(
    request: JsonRpcRequest,
    user: CurrentUserDep,
    session: SessionDep,
) -> JSONResponse:
    """JSON-RPC 2.0 over HTTP：MCP initialize / tools/list / tools/call。"""
    method = request.method
    request_id = request.id

    if method == "initialize":
        return _rpc_result(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        )

    if method == "tools/list":
        return _rpc_result(request_id, {"tools": TOOLS})

    if method == "tools/call":
        params = request.params or {}
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {}
        return _rpc_result(
            request_id, await _dispatch_tool_call(user, session, name, arguments)
        )

    return _rpc_error(request_id, -32601, f"Method not found: {method}")
