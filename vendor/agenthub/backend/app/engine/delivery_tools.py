"""工具必须经 ToolExecutor，直接 ainvoke 不能越过租户和执行上下文。"""

import uuid

from langchain_core.tools import tool
from sqlalchemy import select

from app.agents.resources import create_agent_resource
from app.database import async_session_factory
from app.models import Agent, Execution, User
from app.schemas.agent import AgentCreate


async def tool_identity(organization_id):
    from app.engine.tool_executor import current_tool_execution_id, current_tool_user_id

    user_id, execution_id = current_tool_user_id.get(), current_tool_execution_id.get()
    if not user_id or not execution_id:
        raise PermissionError("Missing tool execution identity")
    async with async_session_factory() as session:
        user = await session.get(User, uuid.UUID(user_id))
        execution = await session.get(Execution, uuid.UUID(execution_id))
        if (
            not user
            or not user.is_active
            or not execution
            or user.organization_id != organization_id
            or execution.organization_id != organization_id
            or execution.user_id != user.id
        ):
            raise PermissionError("Tool tenant permission denied")
        return user, execution


@tool
async def create_agent(
    name: str, description: str, system_prompt: str, tools: list[str]
) -> dict:
    """保存可运行的自定义 Agent。必须经过人工审批；tools 仅可填注册工具名称。"""
    raise PermissionError("Use ToolExecutor")


async def run_create_agent(params, organization_id):
    user, _execution = await tool_identity(organization_id)
    if user.role not in {"admin", "member"}:
        raise PermissionError("resources:write permission denied")
    from app.engine.tool_registry import get_tool

    payload = AgentCreate.model_validate(params)
    if any(not isinstance(name, str) or not get_tool(name) for name in payload.tools):
        raise ValueError("存在未注册工具，请先接入所需连接器。")
    async with async_session_factory() as session:
        agent = await create_agent_resource(session, payload, organization_id)
        return {
            "status": "success",
            "data": {
                "agent_id": str(agent.id),
                "name": agent.name,
                "tools": agent.tools,
                "url": "/agents",
                "run_url": f"/api/agents/{agent.id}/run",
                "note": "配置已保存；实际业务能力以已连接工具和试运行结果为准。",
            },
            "error": None,
        }


@tool
async def get_agent(agent_id: str) -> dict:
    """查看当前租户保存的 Agent 配置，验证资源是否存在。"""
    raise PermissionError("Use ToolExecutor")


async def run_get_agent(params, organization_id):
    await tool_identity(organization_id)
    async with async_session_factory() as session:
        row = (
            await session.execute(
                select(Agent).where(
                    Agent.id == uuid.UUID(params["agent_id"]),
                    Agent.organization_id == organization_id,
                )
            )
        ).scalar_one_or_none()
        if not row:
            return {"status": "failed", "error": "Agent not found", "data": None}
        return {
            "status": "success",
            "error": None,
            "data": {
                "agent_id": str(row.id),
                "name": row.name,
                "system_prompt": row.system_prompt,
                "tools": row.tools,
            },
        }


@tool
async def export_document(title: str, content: str, format: str = "pdf") -> dict:
    """将完整源稿导出为持久化可下载 PDF / DOCX / MD，format 取 pdf/docx/md。"""
    raise PermissionError("Use ToolExecutor")


async def run_export_document(params, organization_id):
    from app.artifacts.service import export_document as export

    user, execution = await tool_identity(organization_id)
    params = {**params, "format": params.get("format") or "pdf"}
    artifact = await export(str(execution.id), str(user.id), organization_id, **params)
    if params.get("format", "pdf") != "md":
        source = await export(
            str(execution.id),
            str(user.id),
            organization_id,
            title=params["title"],
            content=params["content"],
            format="md",
        )
        artifact["source_artifact"] = source
    return {"status": "success", "data": artifact, "error": None}


@tool
async def report_blocker(reason: str, required_conditions: list[str]) -> dict:
    """记录真实无法完成的部分及继续所需条件，同时保留已完成的结果。"""
    return {
        "status": "success",
        "data": {
            "blocker": {
                "code": "capability_gap",
                "reason": reason,
                "next_actions": required_conditions,
            }
        },
        "error": None,
    }


async def run_report_blocker(params, organization_id):
    await tool_identity(organization_id)
    return await report_blocker.ainvoke(params)


def register_delivery_tools():
    from app.engine.tool_registry import register_tool

    for tool_, handler, effect in [
        (create_agent, run_create_agent, True),
        (get_agent, run_get_agent, False),
        (export_document, run_export_document, False),
        (report_blocker, run_report_blocker, False),
    ]:
        register_tool(
            tool_.name,
            tool_.description,
            tool_.args_schema.model_json_schema(),
            handler,
            requires_approval=effect,
            side_effect=effect,
            timeout=60,
        )
