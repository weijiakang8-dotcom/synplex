"""Chat Runtime：同步流式、不经 Celery、不进入 Agent Graph。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage

from app.core.context_policy import data_message
from app.core.model_gateway import ModelGateway
from app.engine.capabilities import RESPONSE_FORMAT_PROMPT
from app.engine.runner import (
    _clean_message_dicts,
    _to_langchain_message,
)

CHAT_SYSTEM_PROMPT = (
    "你是 AgentHub 的智能助手。请直接、准确、自然地回答用户的问题；"
    "如果用户只是打招呼，就友好地简短回应；如果信息不足，请向用户提问澄清。"
    "如果上下文中提供了【联网搜索结果】，请优先基于这些最新结果回答，"
    "涉及外部事实时尽量标注来源；如果搜索失败，如实说明未能联网检索，"
    "再基于已有知识回答，不要编造搜索结果。"
    "本平台的任务执行模式支持检索资料、查询授权数据、审批后创建Agent、"
    "生成可下载PDF/DOCX/Markdown文件；任务工作台可接独立执行器生成代码和数据成果。"
    "工具是否已连接和有权限需要在执行时核对。聊天回复本身没有执行工具，"
    "不能据此声称整个平台没有这些功能，也不能声称已经创建了文件或外部操作。"
    f"\n\n{RESPONSE_FORMAT_PROMPT}"
)


def build_chat_messages(
    prior_messages: Any,
    user_input: str,
    *,
    summary: str | None = None,
    memories: list[dict[str, Any]] | None = None,
) -> list[BaseMessage]:
    cleaned = _clean_message_dicts(prior_messages)
    messages = [_to_langchain_message(message) for message in cleaned]
    context_notes: list[str] = []
    if summary:
        context_notes.append(f"【更早对话摘要】{summary}")
    if memories:
        context_notes.append(
            "【关于用户的已知信息】" + "；".join(f"{m['content']}" for m in memories)
        )
    if context_notes:
        messages.insert(0, data_message("历史摘要与用户记忆", "\n".join(context_notes)))
    if user_input:
        messages.append(HumanMessage(content=user_input))
    return messages


async def iter_chat_tokens(
    llms: list,
    messages: list[BaseMessage],
    *,
    organization_id: str | None = None,
    correlation_id: str | None = None,
    usage_sink: list | None = None,
) -> AsyncIterator[str]:
    gateway = ModelGateway()
    async for token in gateway.stream(
        llms,
        messages,
        task_type="chat",
        organization_id=organization_id,
        correlation_id=correlation_id,
        usage_sink=usage_sink,
    ):
        yield token


def chat_usage_entries(
    model_used: str | None,
    classify_metadata: dict[str, Any] | None,
    input_tokens: int,
    output_tokens: int,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    if classify_metadata:
        entries.append(dict(classify_metadata))
    if model_used:
        entries.append(
            {
                "model_used": model_used,
                "fallback": False,
                "attempts": 1,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }
        )
    return entries


__all__ = [
    "CHAT_SYSTEM_PROMPT",
    "build_chat_messages",
    "chat_usage_entries",
    "iter_chat_tokens",
]
