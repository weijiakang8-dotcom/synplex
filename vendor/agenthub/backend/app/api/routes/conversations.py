from __future__ import annotations

import json
import logging
import uuid

import redis.asyncio as aioredis
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import SystemMessage
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUserDep, SessionDep
from app.config import settings
from app.core.billing import estimate_tokens, record_execution_usage
from app.core.context_policy import data_message
from app.core.model_gateway import get_chat_models
from app.core.model_selection import ModelSelectionError, resolve_selection
from app.core.quota import QuotaExceededError
from app.database import async_session_factory
from app.engine import tool_executor
from app.engine.chat import (
    CHAT_SYSTEM_PROMPT,
    build_chat_messages,
    chat_usage_entries,
    iter_chat_tokens,
)
from app.engine.event_bus import CHANNEL_PREFIX, publish_execution_event
from app.engine.intent import IntentDecision, IntentRouter, RuntimeKind
from app.engine.observability import record_span
from app.engine.runner import build_context_messages
from app.engine.tasks import evaluate_execution_task, execute_workflow_task
from app.engine.tools import build_search_query, format_search_results
from app.memory.conversation_context import compact_conversation, summary_text
from app.memory.service import add_memory, retrieve_memories, summarize_text
from app.models import Conversation, Execution, Skill, Workflow, utcnow
from app.models.enums import ExecutionStatus
from app.rag.retrieval import retrieve_documents

router = APIRouter(prefix="/conversations", tags=["conversations"])
logger = logging.getLogger(__name__)

_TERMINAL_STATUSES = {
    ExecutionStatus.COMPLETED,
    ExecutionStatus.FAILED,
    ExecutionStatus.ROLLED_BACK,
}


class ConversationCreate(BaseModel):
    title: str = "新对话"


class MessageRequest(BaseModel):
    content: str
    # 聊天模式：chat=纯聊天（不走任务流程）/ agent=多 Agent 协作（默认）/ skills=技能插件
    mode: str = "agent"
    skill_id: str | None = None
    # 会话级模型选择；留空表示继续沿用会话已保存的选择或走自动路由。
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None


def _serialize(conversation: Conversation) -> dict:
    return {
        "id": str(conversation.id),
        "title": conversation.title,
        "messages": conversation.messages,
        "summary": summary_text(conversation.summary),
        "model_selection": conversation.model_selection or None,
        "created_at": conversation.created_at.isoformat(),
        "updated_at": conversation.updated_at.isoformat(),
    }


async def _persist_assistant_message(
    session,
    conversation_id: uuid.UUID,
    content: str,
    execution_id: uuid.UUID | None = None,
) -> None:
    """在当前 session 内持久化 assistant 最终回复，避免 detached 对象丢失写入。"""
    current_conversation = await session.get(Conversation, conversation_id)
    if current_conversation is None:
        return
    messages = list(current_conversation.messages or [])
    if execution_id is None:
        messages.append({"role": "assistant", "content": content})
    else:
        messages = _upsert_reply(messages, str(execution_id), content)
    current_conversation.messages = messages
    await session.commit()


def _upsert_reply(messages: list, execution_id: str, content: str) -> list:
    result = list(messages)
    for index, message in enumerate(result):
        if (
            message.get("role") == "assistant"
            and message.get("execution_id") == execution_id
        ):
            result[index] = {**message, "content": content}
            return result
    reply = {"role": "assistant", "content": content, "execution_id": execution_id}
    for index, message in enumerate(result):
        if (
            message.get("role") == "user"
            and message.get("execution_id") == execution_id
        ):
            result.insert(index + 1, reply)
            return result
    result.append(reply)
    return result


@router.get("")
async def list_conversations(session: SessionDep, user: CurrentUserDep) -> list[dict]:
    stmt = select(Conversation).order_by(Conversation.updated_at.desc()).limit(200)
    if user.organization_id is not None:
        stmt = stmt.where(Conversation.organization_id == user.organization_id)
    result = await session.execute(stmt)
    return [_serialize(c) for c in result.scalars().all()]


@router.post("", status_code=201)
async def create_conversation(
    payload: ConversationCreate, session: SessionDep, user: CurrentUserDep
) -> dict:
    conversation = Conversation(
        user_id=user.id,
        organization_id=user.organization_id,
        title=payload.title or "新对话",
        messages=[],
    )
    session.add(conversation)
    await session.commit()
    await session.refresh(conversation)
    return _serialize(conversation)


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> dict:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None or (
        user.organization_id is not None
        and conversation.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize(conversation)


@router.put("/{conversation_id}")
async def append_message(
    conversation_id: uuid.UUID,
    payload: MessageRequest,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None or (
        user.organization_id is not None
        and conversation.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = list(conversation.messages or [])
    messages.append({"role": "user", "content": payload.content})
    conversation.messages = messages
    if conversation.title == "新对话" and payload.content:
        conversation.title = payload.content[:24]
    await session.commit()
    await session.refresh(conversation)
    return _serialize(conversation)


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: uuid.UUID, session: SessionDep, user: CurrentUserDep
) -> None:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None or (
        user.organization_id is not None
        and conversation.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Conversation not found")
    await session.delete(conversation)
    await session.commit()


async def _get_or_create_chat_workflow(org_id: uuid.UUID | None) -> uuid.UUID:
    async with async_session_factory() as session:
        stmt = select(Workflow).where(Workflow.name == "__chat_default__")
        if org_id is not None:
            stmt = stmt.where(Workflow.organization_id == org_id)
        workflow = (await session.execute(stmt)).scalars().first()
        if workflow is None:
            workflow = Workflow(
                name="__chat_default__",
                description="Chat default workflow",
                agent_chain=[],
                dag_definition=None,
                created_by="system",
                organization_id=org_id,
            )
            session.add(workflow)
            await session.commit()
        return workflow.id


@router.post("/{conversation_id}/stream")
async def stream_conversation(
    conversation_id: uuid.UUID,
    payload: MessageRequest,
    user: CurrentUserDep,
) -> StreamingResponse:
    async with async_session_factory() as session:
        conversation = await session.get(Conversation, conversation_id)
        if conversation is None or (
            user.organization_id is not None
            and conversation.organization_id != user.organization_id
        ):
            raise HTTPException(status_code=404, detail="Conversation not found")

        prior_messages = list(conversation.messages or [])
        summary = conversation.summary
        # 选择优先级：本次请求显式指定 → 会话已保存 → 空（自动路由）。
        requested = {
            "provider": payload.provider,
            "model": payload.model,
            "reasoning_effort": payload.reasoning_effort,
        }
        has_request_choice = bool(
            (payload.provider or "").strip() and (payload.model or "").strip()
        )
        effective_selection = (
            requested if has_request_choice else (conversation.model_selection or None)
        )
        if effective_selection:
            try:
                await resolve_selection(user.organization_id, effective_selection)
            except ModelSelectionError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={"code": exc.code, "message": exc.message},
                ) from exc
        if has_request_choice:
            conversation.model_selection = requested
        request_message_id = str(uuid.uuid4())
        messages = [
            *prior_messages,
            {"role": "user", "content": payload.content, "id": request_message_id},
        ]
        conversation.messages = messages
        if conversation.title == "新对话" and payload.content:
            conversation.title = payload.content[:24]
        await session.commit()

    workflow_id = await _get_or_create_chat_workflow(user.organization_id)
    async with async_session_factory() as session:
        execution = Execution(
            workflow_id=workflow_id,
            user_input=payload.content,
            context_messages=build_context_messages(prior_messages),
            status=ExecutionStatus.PENDING,
            current_step_index=0,
            organization_id=user.organization_id,
            user_id=user.id,
            model_selection=conversation.model_selection or None,
        )
        session.add(execution)
        await session.commit()
        await session.refresh(execution)
        execution_id = execution.id
        # JSON message metadata binds a turn to its execution without a migration.
        current = await session.get(Conversation, conversation_id)
        if current is not None:
            turns = list(current.messages or [])
            turns = [
                (
                    {**turn, "execution_id": str(execution_id)}
                    if turn.get("id") == request_message_id
                    else turn
                )
                for turn in turns
            ]
            current.messages = _upsert_reply(turns, str(execution_id), "")
            await session.commit()

    return StreamingResponse(
        _conversation_event_stream(
            execution_id,
            conversation_id,
            payload.content,
            prior_messages,
            user.organization_id,
            user.id,
            summary,
            mode=payload.mode,
            skill_id=payload.skill_id,
        ),
        media_type="text/event-stream",
    )


@router.post("/{conversation_id}/summarize")
async def summarize_conversation(
    conversation_id: uuid.UUID,
    session: SessionDep,
    user: CurrentUserDep,
) -> dict:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None or (
        user.organization_id is not None
        and conversation.organization_id != user.organization_id
    ):
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not conversation.messages:
        return {"summary": conversation.summary or ""}
    summary = await summarize_text(
        messages=conversation.messages,
        organization_id=(str(user.organization_id) if user.organization_id else None),
        user_id=str(user.id),
    )
    conversation.summary = summary
    await session.commit()
    return {"summary": summary_text(summary)}


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _partial_chat_output(parts: list[str], explanation: str) -> str:
    text = "".join(parts)
    return f"{text}\n\n未完成部分：{explanation}" if text.strip() else explanation


async def _finalize_chat_execution(
    execution_id: uuid.UUID,
    conversation_id: uuid.UUID,
    final_output: str | None,
    *,
    error: str | None = None,
    usage_entries: list | None = None,
    delivery: dict | None = None,
) -> None:
    """在一个事务里落库执行结果与 assistant 消息，避免多次往返。"""
    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is not None:
            execution.status = (
                ExecutionStatus.FAILED
                if error is not None
                else ExecutionStatus.COMPLETED
            )
            execution.final_output = final_output
            execution.error_message = error
            execution.completed_at = utcnow()
            execution.steps = [{"role": "chat", "name": "chat", "agent_id": None}]
            if usage_entries:
                execution.checkpoint_data = {
                    **(execution.checkpoint_data or {}),
                    "llm_usage": usage_entries,
                }
            if delivery:
                execution.checkpoint_data = {
                    **(execution.checkpoint_data or {}),
                    "delivery": delivery,
                }

        conversation = await session.get(Conversation, conversation_id)
        if conversation is not None:
            assistant_content = final_output or (
                f"请求失败：{error}" if error is not None else ""
            )
            if assistant_content:
                messages = list(conversation.messages or [])
                conversation.messages = _upsert_reply(
                    messages, str(execution_id), assistant_content
                )
        await session.commit()

    if final_output:
        try:
            await record_execution_usage(execution_id)
        except Exception:
            logger.warning("Failed to record chat usage", exc_info=True)
        if error is None:
            try:
                evaluate_execution_task.delay(str(execution_id))
            except Exception:
                logger.warning("Failed to enqueue chat evaluation", exc_info=True)

    try:
        await record_span(
            trace_id=(
                str(execution.correlation_id)
                if execution is not None
                else str(execution_id)
            ),
            name="respond",
            status="ok" if error is None else "error",
            error=error,
            details={
                "execution_id": str(execution_id),
                "conversation_id": str(conversation_id),
            },
        )
    except Exception:
        logger.debug("Failed to record respond span", exc_info=True)


async def _execution_event_stream(
    execution_id: uuid.UUID,
    conversation_id: uuid.UUID,
):
    """Agent 路径：订阅 Redis 事件 + 每秒轮询执行状态，直到结束。"""
    redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = redis.pubsub()
    channel = f"{CHANNEL_PREFIX}{execution_id}"
    try:
        await pubsub.subscribe(channel)
        counter = 0
        while True:
            counter += 1
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=0.2
            )
            if message is not None and message.get("type") == "message":
                yield f"data: {message['data']}\n\n"

            if counter % 5 != 0:
                continue
            async with async_session_factory() as session:
                execution = await session.get(Execution, execution_id)
                if execution is None:
                    yield _sse({"event": "error", "message": "execution not found"})
                    return
                yield _sse(
                    {
                        "event": "status",
                        "execution_id": str(execution_id),
                        "status": execution.status.value,
                        "final_output": execution.final_output,
                        "error_message": execution.error_message,
                        "delivery": (execution.checkpoint_data or {}).get("delivery"),
                    }
                )
                if execution.status in _TERMINAL_STATUSES:
                    if execution.final_output:
                        await _persist_assistant_message(
                            session,
                            conversation_id,
                            execution.final_output,
                            execution_id,
                        )
                    await record_span(
                        trace_id=(
                            str(execution.correlation_id)
                            if execution.correlation_id
                            else str(execution_id)
                        ),
                        name="respond",
                        status=(
                            "ok"
                            if execution.status == ExecutionStatus.COMPLETED
                            else "error"
                        ),
                        error=execution.error_message,
                        details={
                            "execution_id": str(execution_id),
                            "conversation_id": str(conversation_id),
                        },
                    )
                    yield _sse(
                        {
                            "event": "done",
                            "status": execution.status.value,
                            "final_output": execution.final_output,
                            "error_message": execution.error_message,
                            "execution_id": str(execution_id),
                            "delivery": (execution.checkpoint_data or {}).get(
                                "delivery"
                            ),
                        }
                    )
                    return
    finally:
        try:
            await pubsub.unsubscribe(channel)
        except Exception:
            logger.debug("Failed to unsubscribe from execution channel", exc_info=True)
        await pubsub.aclose()
        await redis.aclose()


async def _conversation_event_stream(
    execution_id: uuid.UUID,
    conversation_id: uuid.UUID,
    user_input: str,
    prior_messages: list,
    organization_id: uuid.UUID | None,
    user_id: uuid.UUID | None,
    summary: str | None,
    *,
    mode: str = "agent",
    skill_id: str | None = None,
):
    """Chat 主链路：先分类，任务型走 Agent 队列，其余直接流式回答。

    mode=chat：强制纯聊天（ChatGPT 式，不进入任务流程）；
    mode=skills：按选定 Skill 的骨架执行（注入 plan + 记录使用）。
    """
    execution_id_str = str(execution_id)
    yield _sse(
        {
            "event": "status",
            "execution_id": execution_id_str,
            "status": ExecutionStatus.PENDING.value,
            "final_output": None,
            "mode": mode,
        }
    )

    async def stage(phase: str, status: str, description: str) -> dict:
        event = {
            "event": "activity",
            "phase": phase,
            "status": status,
            "description": description,
            "execution_id": execution_id_str,
        }
        await publish_execution_event(execution_id_str, event)
        return event

    yield _sse(await stage("intent", "started", "正在理解你的请求"))

    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        correlation_id = (
            str(execution.correlation_id) if execution is not None else None
        )

    decision: IntentDecision = await IntentRouter().classify(
        user_input,
        summary=summary,
        recent_messages=prior_messages,
        organization_id=str(organization_id) if organization_id else None,
        user_id=str(user_id) if user_id else None,
        correlation_id=execution_id_str,
    )
    yield _sse(await stage("intent", "completed", "已理解请求"))
    yield _sse(await stage("context", "started", "正在整理相关上下文"))
    async with async_session_factory() as session:
        execution = await session.get(Execution, execution_id)
        if execution is not None:
            execution.intent = decision.model_dump()
            await session.commit()

    # Memory Policy：仅显式表达（save/update）时写入长期记忆，失败不打断聊天
    if decision.memory_intent in {"save", "update"}:
        try:
            await add_memory(
                user_id=user_id,
                organization_id=organization_id,
                content=user_input,
                source="user",
            )
        except Exception:
            logger.warning(
                "Explicit memory write failed; continuing chat", exc_info=True
            )

    try:
        context_llms = await get_chat_models(
            organization_id=str(organization_id) if organization_id else None,
            complexity="simple",
            user_id=str(user_id) if user_id else None,
        )
        original_summary = summary
        prior_messages, summary, context_summary = await compact_conversation(
            prior_messages,
            user_input,
            summary,
            context_llms,
            organization_id=str(organization_id) if organization_id else None,
            correlation_id=execution_id_str,
        )
        async with async_session_factory() as session:
            conversation = await session.get(Conversation, conversation_id)
            if conversation is not None and conversation.summary == original_summary:
                conversation.summary = summary
            execution = await session.get(Execution, execution_id)
            if execution is not None:
                # Persist the summary as data alongside recent messages; no new schema.
                execution.context_messages = (
                    [
                        {
                            "role": "user",
                            "content": data_message(
                                "更早对话摘要", context_summary
                            ).content,
                        }
                    ]
                    if context_summary
                    else []
                ) + prior_messages
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        from app.engine.delivery import blocker_for

        blocker = blocker_for(exc)
        message = blocker["reason"] + " " + " ".join(blocker["next_actions"])
        await _finalize_chat_execution(
            execution_id,
            conversation_id,
            message,
            error=message,
            delivery={"status": "blocked", "blockers": [blocker]},
        )
        yield _sse(
            {
                "event": "done",
                "execution_id": execution_id_str,
                "status": ExecutionStatus.FAILED.value,
                "final_output": message,
                "delivery": {"status": "blocked", "blockers": [blocker]},
            }
        )
        return

    yield _sse(await stage("context", "completed", "上下文已准备好"))
    if decision.runtime == RuntimeKind.AGENT and mode != "chat":
        # skills 模式：注入选定 Skill 的计划骨架 + 记录使用
        if mode == "skills" and skill_id:
            try:
                skill_uuid = uuid.UUID(skill_id)
            except ValueError:
                skill_uuid = None
            if skill_uuid is not None:
                async with async_session_factory() as session:
                    skill = await session.get(Skill, skill_uuid)
                    if skill is not None and (
                        skill.organization_id is None
                        or skill.organization_id == organization_id
                    ):
                        execution = await session.get(Execution, execution_id)
                        if execution is not None:
                            execution.plan = skill.plan_template
                        skill.times_used += 1
                        skill.last_used_at = utcnow()
                        await session.commit()
        try:
            execute_workflow_task.delay(execution_id_str)
        except Exception:
            logger.warning("Task broker unavailable for chat execution", exc_info=True)
            blocker = {
                "code": "task_queue",
                "reason": "任务队列不可用，本次尚未开始执行。",
                "next_actions": [
                    "恢复任务队列后继续；已保存的目标与历史无需重新输入。"
                ],
            }
            message = blocker["reason"] + " " + " ".join(blocker["next_actions"])
            await _finalize_chat_execution(
                execution_id,
                conversation_id,
                message,
                error=message,
                delivery={"status": "blocked", "blockers": [blocker]},
            )
            yield _sse(
                {
                    "event": "error",
                    "execution_id": execution_id_str,
                    "message": "任务队列不可用，请稍后重试",
                }
            )
            yield _sse(
                {
                    "event": "done",
                    "execution_id": execution_id_str,
                    "status": ExecutionStatus.FAILED.value,
                    "error_message": message,
                    "final_output": message,
                    "delivery": {"status": "blocked", "blockers": [blocker]},
                }
            )
            return
        async for event in _execution_event_stream(execution_id, conversation_id):
            yield event
        return

    search_context: str | None = None
    if decision.needs_web_search:
        query = build_search_query(user_input)
        yield _sse(
            {
                "event": "search",
                "execution_id": execution_id_str,
                "status": "started",
                "query": query,
            }
        )
        try:
            search_result = await tool_executor.execute_tool(
                "search_web", {"query": query}, execution_id
            )
        except Exception:
            logger.warning("Chat web search failed; continuing", exc_info=True)
            search_result = {"status": "failed", "error": "search service error"}
        if search_result.get("status") == "success":
            search_context = format_search_results(search_result.get("data") or [])
        else:
            search_context = format_search_results(
                None, error=str(search_result.get("error") or "search failed")
            )
        yield _sse(
            {
                "event": "search",
                "execution_id": execution_id_str,
                "status": "completed",
                "ok": search_result.get("status") == "success",
            }
        )

    llms = await get_chat_models(
        organization_id=str(organization_id) if organization_id else None,
        complexity="simple",
        user_id=str(user_id) if user_id else None,
    )
    model_used = getattr(llms[0], "model_name", None) if llms else None
    try:
        memories = await retrieve_memories(
            user_id=user_id,
            organization_id=organization_id,
            query=user_input,
            top_k=3,
            correlation_id=correlation_id,
        )
    except Exception:
        logger.warning("Memory retrieval failed; continuing", exc_info=True)
        memories = []
    messages = build_chat_messages(
        prior_messages,
        user_input,
        summary=context_summary,
        memories=memories,
    )

    system_prompt = CHAT_SYSTEM_PROMPT
    if decision.category.value == "KNOWLEDGE":
        try:
            docs = await retrieve_documents(
                user_input,
                organization_id,
                top_k=3,
                correlation_id=correlation_id,
            )
        except Exception:
            logger.warning(
                "Chat RAG retrieval failed; answering without context", exc_info=True
            )
            docs = []
        if docs:
            snippets = "\n---\n".join(doc["content"][:1000] for doc in docs)
            messages.insert(0, data_message("知识库资料", snippets))

    if search_context:
        messages.insert(0, data_message("联网搜索结果", search_context))

    chat_messages = [SystemMessage(content=system_prompt), *messages]
    parts: list[str] = []
    stream_usage: list[dict] = []
    yield _sse(await stage("respond", "started", "正在生成回答"))
    try:
        async for token in iter_chat_tokens(
            llms,
            chat_messages,
            organization_id=str(organization_id) if organization_id else None,
            correlation_id=execution_id_str,
            usage_sink=stream_usage,
        ):
            parts.append(token)
            yield _sse(
                {
                    "event": "token",
                    "execution_id": execution_id_str,
                    "token": token,
                }
            )
        final_output = "".join(parts)
        if not final_output.strip():
            raise RuntimeError("model returned empty output")
        await _finalize_chat_execution(
            execution_id,
            conversation_id,
            final_output or None,
            usage_entries=stream_usage
            or chat_usage_entries(
                model_used,
                None,
                input_tokens=estimate_tokens(user_input),
                output_tokens=estimate_tokens(final_output or ""),
            ),
        )
        yield _sse(
            {
                "event": "done",
                "execution_id": execution_id_str,
                "status": ExecutionStatus.COMPLETED.value,
                "final_output": final_output,
            }
        )
    except QuotaExceededError as exc:
        message = str(exc)
        partial_output = "".join(parts)
        blocker = {
            "code": "budget",
            "reason": message,
            "next_actions": ["缩小任务范围，或提高配额后继续。"],
        }
        message += " " + " ".join(blocker["next_actions"])
        await _finalize_chat_execution(
            execution_id,
            conversation_id,
            _partial_chat_output(parts, message),
            error=message,
            usage_entries=stream_usage,
            delivery={
                "status": "partial" if partial_output else "blocked",
                "blockers": [blocker],
            },
        )
        yield _sse(
            {
                "event": "error",
                "execution_id": execution_id_str,
                "message": message,
            }
        )
        yield _sse(
            {
                "event": "done",
                "execution_id": execution_id_str,
                "status": ExecutionStatus.FAILED.value,
                "error_message": message,
                "final_output": _partial_chat_output(parts, message),
                "delivery": {
                    "status": "partial" if partial_output else "blocked",
                    "blockers": [blocker],
                },
            }
        )
    except Exception as exc:
        logger.warning("Chat streaming failed", exc_info=True)
        from app.engine.delivery import blocker_for

        blocker = blocker_for(exc)
        message = blocker["reason"] + " " + " ".join(blocker["next_actions"])
        partial_output = "".join(parts)
        await _finalize_chat_execution(
            execution_id,
            conversation_id,
            _partial_chat_output(parts, message),
            error=message,
            usage_entries=stream_usage,
            delivery={
                "status": "partial" if partial_output else "blocked",
                "blockers": [blocker],
            },
        )
        yield _sse(
            {
                "event": "error",
                "execution_id": execution_id_str,
                "message": message,
            }
        )
        yield _sse(
            {
                "event": "done",
                "execution_id": execution_id_str,
                "status": ExecutionStatus.FAILED.value,
                "error_message": message,
                "final_output": _partial_chat_output(parts, message),
                "delivery": {
                    "status": "partial" if partial_output else "blocked",
                    "blockers": [blocker],
                },
            }
        )
