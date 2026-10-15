"""Bounded Deep Agents subgraph; no host shell, no direct provider or effect calls."""

from __future__ import annotations

import asyncio
import json
import time

from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool

from app.adapters.gateway_chat_model import CallLedger, GatewayChatModel
from app.engine import tool_executor
from app.engine.tool_registry import get_tool


async def run_general_step(
    state: dict,
    step: dict,
    messages: list,
    *,
    complexity: str,
    tools: list,
    system_prompt: str,
) -> dict:
    if step.get("capability") == "document":
        from app.engine.document_step import export_existing_manuscript

        exported = await export_existing_manuscript(state, step)
        if exported is not None:
            return exported
    from deepagents import create_deep_agent

    ledger = CallLedger(budget=state.get("budget_used") or {})
    model = GatewayChatModel(
        organization_id=state.get("organization_id"),
        user_id=state.get("user_id"),
        execution_id=state["execution_id"],
        task_type=f"agent:{step.get('capability', 'general')}",
        complexity=complexity,
        required_capabilities=step.get("required_model_capabilities") or [],
        ledger=ledger,
    )
    artifacts, blockers, tool_results = [], [], []
    tool_count = 0

    def bridge(tool):
        spec = get_tool(tool.name)
        if not spec or spec.side_effect or spec.requires_approval:
            return None

        async def invoke(**params):
            nonlocal tool_count
            tool_count += 1
            if tool_count > 24:
                from app.adapters.gateway_chat_model import WorkerBudgetExceeded

                raise WorkerBudgetExceeded("worker tool budget exceeded")
            import uuid

            from app.engine.cancellation import ensure_execution_active

            await ensure_execution_active(uuid.UUID(state["execution_id"]))
            result = await tool_executor.execute_tool(
                spec.name, params, state["execution_id"], user_id=state.get("user_id")
            )
            tool_results.append(result)
            data = result.get("data") or {}
            if isinstance(data, dict):
                if spec.name == "export_document" and data.get("download_url"):
                    artifacts.append(data)
                    if data.get("source_artifact"):
                        artifacts.append(data["source_artifact"])
                if data.get("blocker"):
                    blockers.append(data["blocker"])
            return json.dumps(result, ensure_ascii=False, default=str)

        return StructuredTool.from_function(
            coroutine=invoke,
            name=spec.name,
            description=spec.description,
            args_schema=spec.parameters,
        )

    bridged = [wrapped for tool in tools if (wrapped := bridge(tool)) is not None]
    await model.prepare_context_profile(tools=bool(bridged))
    # All specialists inherit the same shared ledger but use their own task profile.
    # No recursive task tool on specialist tools; external frameworks cannot submit effects.
    subagents = [
        {
            "name": "researcher",
            "description": "需要多轮只读检索、核对来源时使用",
            "system_prompt": "检索并核对真实来源；不足则说明。",
            "model": model.model_copy(
                update={"task_type": "agent:research", "complexity": "simple"}
            ),
            "tools": [
                t
                for t in bridged
                if t.name in {"search_web", "search_knowledge", "report_blocker"}
            ],
        },
        {
            "name": "writer",
            "description": "依据已取得的材料撰写与整理文稿",
            "system_prompt": "依据输入材料撰写，不编造资料和实验结果。",
            "model": model.model_copy(update={"task_type": "agent:writing"}),
            "tools": [
                t for t in bridged if t.name in {"export_document", "report_blocker"}
            ],
        },
    ]
    agent = create_deep_agent(
        model=model,
        tools=bridged,
        system_prompt=system_prompt
        + "\n只执行委派的子任务。工具未返回成功不得声称已执行。缺工具、登录、权限或信息时调用 report_blocker，交付能完成的部分并列出剩余条件。用户已明确缺少某项条件时，依据当前工具目录说明缺口，不要用无关检索或被拒查询证明全局不存在；空检索只表示未找到。用户声明、工具目录和实际成功调用分别注明来源；没有查询凭证或审批的工具，不得声称已检查登录态、凭证或审批记录。禁止声称已订票、付款或部署。虚拟文件不等于可下载成果，需 export_document 发布。",
        subagents=subagents,
    )
    elapsed = time.time() - float(ledger.budget.get("started_at", time.time()))
    remaining = max(0.1, float(ledger.budget.get("wall_clock_seconds", 300)) - elapsed)
    result = {}

    async def collect():
        nonlocal result
        async for snapshot in agent.astream(
            {
                "messages": messages,
                "files": (state.get("worker_files") or {}).get(
                    str(step.get("step_id")), {}
                ),
            },
            config={"recursion_limit": 40},
            stream_mode="values",
        ):
            result = snapshot

    try:
        await asyncio.wait_for(collect(), timeout=remaining)
    except Exception as exc:
        from app.engine.cancellation import ExecutionCancelled

        if isinstance(exc, ExecutionCancelled):
            raise
        from app.engine.delivery import blocker_for

        blockers.append(blocker_for(exc))
    responses = [
        m
        for m in result.get("messages", [])
        if isinstance(m, AIMessage) and m.content and not m.tool_calls
    ]
    output = (
        str(responses[-1].content)
        if responses
        else "未生成最终文本；请查看已保存的成果与工具结果。"
    )
    if any(r.get("status") not in {"success", "duplicate"} for r in tool_results):
        blockers.append(
            {
                "code": "tool",
                "reason": "部分工具调用未返回成功；相关结果尚未交付。",
                "next_actions": ["检查工具配置或必要参数后重试该部分。"],
            }
        )
    return {
        "output": output,
        "usage": ledger.usage,
        "artifacts": artifacts,
        "blockers": blockers,
        "files": result.get("files") or {},
    }
