from __future__ import annotations

import asyncio
import email.utils
import hashlib
import json
import re
import smtplib
import threading
import uuid
from email.message import EmailMessage
from typing import Any

import httpx
from langchain_core.tools import tool
from sqlalchemy import text

from app.config import settings
from app.database import engine

_SELECT_RE = re.compile(r"^\s*SELECT\b", re.IGNORECASE)
_DANGEROUS_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|COPY|GRANT|REVOKE|CALL|DO|VACUUM|REINDEX)\b",
    re.IGNORECASE,
)
_FORBIDDEN_SQL_RE = re.compile(
    r"[();]|--|/\*|\bJOIN\b|\bUNION\b|\bINTO\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b",
    re.IGNORECASE,
)
_AGGREGATE_SELECT_RE = re.compile(
    r"^\s*SELECT\s+"
    r"(?P<agg>COUNT\(\s*\*\s*\)|COUNT\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)|"
    r"SUM\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)|AVG\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)|"
    r"MIN\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)|MAX\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\))"
    r"\s+FROM\s+(?P<table>[A-Za-z_][A-Za-z0-9_]*)\s*(?P<rest>.*)$",
    re.IGNORECASE | re.DOTALL,
)
_AGGREGATE_FORBIDDEN_RE = re.compile(
    r";|--|/\*|\bJOIN\b|\bUNION\b|\bINTO\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b",
    re.IGNORECASE,
)

# query_db 只允许访问这些带 organization_id 的业务表。
# 敏感表（users / organizations / model_configs / api_keys / audit_logs 等）被自动拒绝。
_QUERY_DB_ALLOWED_TABLES = frozenset(
    {"agents", "workflows", "executions", "documents", "tool_calls"}
)
_QUERY_DB_MAX_ROWS = 100

_SENT_EMAIL_HASHES: set[str] = set()
_EMAIL_HASH_LOCK = threading.Lock()

_SEARCH_PREFIXES = (
    "帮我搜索一下",
    "帮我搜一下",
    "帮我查一下",
    "帮我查一查",
    "帮我查查",
    "搜索一下",
    "搜一下",
    "查一下",
    "查一查",
    "查查",
    "搜搜",
    "帮我搜",
    "帮我查",
    "搜一搜",
)
_SEARCH_TRAILING = "，。！？!?;；:： "


def build_search_query(user_input: str) -> str:
    """从用户输入中提取搜索词：去掉常见祈使前缀与标点。

    只做确定性裁剪，不调用模型；裁剪失败时原样返回，绝不返回空串。
    """
    text = (user_input or "").strip()
    for prefix in _SEARCH_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :].strip(_SEARCH_TRAILING)
            break
    return text or (user_input or "").strip()


def format_search_results(
    results: list[dict] | None,
    *,
    error: str | None = None,
    max_results: int = 5,
) -> str:
    """把 search_web 结果格式化为注入 LLM 上下文的证据块。

    成功时列出标题/来源/摘要；失败时诚实标注失败原因，并明确要求不得编造
    搜索结果。长度有上限，防止搜索内容撑爆上下文。
    """
    if not results:
        reason = error or "unknown"
        return (
            "【联网搜索（自动检索）】本次未能获取搜索结果："
            f"{reason[:300]}。请明确告知用户联网检索未成功，"
            "然后基于已有知识回答；不得编造搜索结果或来源。"
        )
    lines = ["【联网搜索结果（自动检索，仅供参考）】"]
    for index, item in enumerate(results[:max_results], start=1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip() or "无标题"
        url = str(item.get("url") or item.get("href") or "").strip()
        snippet = str(
            item.get("content") or item.get("snippet") or item.get("body") or ""
        ).strip()
        lines.append(f"{index}. {title}")
        if url:
            lines.append(f"   来源: {url}")
        if snippet:
            lines.append(f"   摘要: {snippet[:600]}")
    lines.append(
        "【使用要求】把以上结果当作参考证据回答；涉及外部事实时标注来源；"
        "如果结果不足以回答，如实说明，不要编造。"
    )
    return "\n".join(lines)


def _coerce_org_id(organization_id: Any) -> uuid.UUID | None:
    if organization_id is None:
        return None
    if isinstance(organization_id, uuid.UUID):
        return organization_id
    try:
        return uuid.UUID(str(organization_id))
    except (ValueError, TypeError):
        return None


def _parse_scoped_select(sql: str) -> tuple[str, str, str | None, int | None] | None:
    """只接受：SELECT <cols> FROM <table> [WHERE <cond>] [LIMIT <n>] 单表结构。"""
    match = re.match(
        r"^\s*SELECT\s+(?P<select>.+?)\s+FROM\s+"
        r"(?P<table>[A-Za-z_][A-Za-z0-9_]*)\s*(?P<rest>.*)$",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None

    select_list = match.group("select").strip()
    table = match.group("table").lower()
    rest = match.group("rest").strip()
    where_condition: str | None = None
    limit_value: int | None = None

    if rest:
        where_match = re.match(
            r"^WHERE\s+(?P<where>.+)$", rest, re.IGNORECASE | re.DOTALL
        )
        if where_match:
            where_part = where_match.group("where").strip()
            limit_match = re.search(
                r"\s+LIMIT\s+(?P<limit>\d+)\s*$", where_part, re.IGNORECASE
            )
            if limit_match:
                limit_value = int(limit_match.group("limit"))
                where_part = where_part[: limit_match.start()].strip()
            where_condition = where_part
        else:
            limit_match = re.match(r"^LIMIT\s+(?P<limit>\d+)\s*$", rest, re.IGNORECASE)
            if limit_match:
                limit_value = int(limit_match.group("limit"))
            else:
                return None

    return select_list, table, where_condition, limit_value


def _build_scoped_sql(
    select_list: str,
    table: str,
    where_condition: str | None,
    limit_value: int | None,
) -> str:
    statement = f"SELECT {select_list} FROM {table}"
    if where_condition:
        statement += f" WHERE ({where_condition}) AND organization_id = :org"
    else:
        statement += " WHERE organization_id = :org"
    if limit_value is not None:
        statement += f" LIMIT {limit_value}"
    return statement


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


@tool
async def search_web(query: str) -> dict:
    """Search the web for the given query, preferring Tavily then DuckDuckGo."""
    if settings.TAVILY_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    "https://api.tavily.com/search",
                    json={
                        "api_key": settings.TAVILY_API_KEY,
                        "query": query,
                        "max_results": 5,
                    },
                )
                response.raise_for_status()
                data = response.json()
            return {"status": "success", "data": data.get("results", []), "error": None}
        except Exception as exc:  # noqa: BLE001
            return {"status": "failed", "data": None, "error": str(exc)}

    try:
        from duckduckgo_search import DDGS

        def _ddg() -> list[dict]:
            with DDGS() as ddg:
                return list(ddg.text(query, max_results=5))

        results = await asyncio.to_thread(_ddg)
        summaries = [
            {
                "title": item.get("title", ""),
                "url": item.get("href", ""),
                "snippet": item.get("body", ""),
            }
            for item in results[:5]
        ]
        return {"status": "success", "data": summaries, "error": None}
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "failed",
            "data": None,
            "error": f"TAVILY_API_KEY not configured and DuckDuckGo fallback failed: {exc}",
        }


@tool
async def query_db(sql: str) -> dict:
    """Run a single read-only SELECT query against the AgentHub database (PostgreSQL).

    仅允许单表 SELECT，服务端自动注入 organization_id 租户过滤。
    统计查询允许 COUNT(*)/COUNT(col)/SUM(col)/AVG(col)/MIN(col)/MAX(col)（单表、
    只读、自动租户过滤）。禁止 INSERT/UPDATE/DELETE、JOIN、子查询、ORDER BY/
    GROUP BY、PRAGMA。
    可查询的表与常用列：
    - executions: status, user_input, final_output, error_message,
      current_step_index, created_at, updated_at, completed_at
    - tool_calls: execution_id, tool_name, status, input_params,
      output_result, requires_approval, created_at
    - workflows: name, description, status, created_at, updated_at
    - documents: name, content, created_at
    - agents: name, description, status
    状态取值：pending / running / waiting_for_approval / completed / failed /
    rolled_back。
    示例：SELECT status, created_at FROM executions LIMIT 10
    统计示例：SELECT COUNT(*) FROM executions
    """
    # 实际执行统一走 run_query_db，租户由执行引擎服务端注入，不允许 Agent 自行决定。
    return await run_query_db(sql, None)


async def run_search_knowledge(
    query: str,
    organization_id: Any,
    *,
    top_k: int = 5,
) -> dict:
    """检索当前租户知识库（RAG）：只读、强制租户隔离、失败 fail-open 为空。"""
    from app.rag.retrieval import retrieve_chunks

    query = (query or "").strip()
    if not query:
        return {
            "status": "failed",
            "data": None,
            "error": "query is required",
        }
    org_id = _coerce_org_id(organization_id)
    if org_id is None:
        return {
            "status": "failed",
            "data": None,
            "error": "tenant context required",
        }
    try:
        chunks = await retrieve_chunks(
            query,
            org_id,
            top_k=max(1, min(int(top_k or 5), 10)),
        )
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "data": None, "error": str(exc)}
    return {"status": "success", "data": chunks, "error": None}


@tool
async def search_knowledge(query: str, top_k: int = 5) -> dict:
    """Search the tenant knowledge base (RAG) for the given query.

    Only returns content from the current organization's documents.
    """
    return await run_search_knowledge(query, None, top_k=top_k)


async def run_recall_memory(
    query: str,
    organization_id: Any,
    *,
    user_id: Any = None,
    top_k: int = 3,
) -> dict:
    """检索当前用户长期记忆（只读；租户 + 用户双重隔离）。"""
    query = (query or "").strip()
    if not query:
        return {"status": "failed", "data": None, "error": "query is required"}
    org_id = _coerce_org_id(organization_id)
    if org_id is None:
        return {"status": "failed", "data": None, "error": "tenant context required"}
    if user_id is None:
        from app.engine.tool_executor import current_tool_user_id

        user_id = current_tool_user_id.get()
    if user_id is None:
        return {"status": "failed", "data": None, "error": "user context required"}
    try:
        from app.memory.service import retrieve_memories

        memories = await retrieve_memories(
            user_id=uuid.UUID(str(user_id)),
            organization_id=org_id,
            query=query,
            top_k=max(1, min(int(top_k or 3), 10)),
        )
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "data": None, "error": str(exc)}
    return {"status": "success", "data": memories, "error": None}


async def run_recall_executions(
    organization_id: Any,
    *,
    user_id: Any = None,
    limit: int = 5,
) -> dict:
    """检索最近完成的执行记录（只读；租户隔离，可按用户过滤）。"""
    org_id = _coerce_org_id(organization_id)
    if org_id is None:
        return {"status": "failed", "data": None, "error": "tenant context required"}
    if user_id is None:
        from app.engine.tool_executor import current_tool_user_id

        user_id = current_tool_user_id.get()
    try:
        from sqlalchemy import select

        from app.database import async_session_factory
        from app.models import Execution
        from app.models.enums import ExecutionStatus

        stmt = select(Execution).where(
            Execution.organization_id == org_id,
            Execution.status == ExecutionStatus.COMPLETED,
        )
        if user_id is not None:
            stmt = stmt.where(Execution.user_id == uuid.UUID(str(user_id)))
        stmt = stmt.order_by(Execution.updated_at.desc()).limit(
            max(1, min(int(limit or 5), 10))
        )
        async with async_session_factory() as session:
            rows = list((await session.execute(stmt)).scalars().all())
        data = [
            {
                "id": str(row.id),
                "user_input": row.user_input,
                "final_output": (row.final_output or "")[:500],
                "status": (
                    row.status.value
                    if hasattr(row.status, "value")
                    else str(row.status)
                ),
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
            }
            for row in rows
        ]
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "data": None, "error": str(exc)}
    return {"status": "success", "data": data, "error": None}


@tool
async def recall_memory(query: str, top_k: int = 3) -> dict:
    """Recall the current user's long-term memory entries relevant to the query."""
    return await run_recall_memory(query, None, top_k=top_k)


@tool
async def recall_executions(limit: int = 5) -> dict:
    """Recall recent completed executions for the current tenant/user."""
    return await run_recall_executions(None, limit=limit)


async def run_query_db(sql: str, organization_id: Any) -> dict:
    """以强制租户边界执行 query_db：只读、单表、白名单、自动注入 org 谓词。"""
    org_id = _coerce_org_id(organization_id)
    if org_id is None:
        return {
            "status": "failed",
            "data": None,
            "error": "tenant context required",
        }

    statement = (sql or "").strip().rstrip(";").strip()
    if (
        not _SELECT_RE.match(statement)
        or _DANGEROUS_RE.search(statement)
        or ";" in statement
    ):
        return {
            "status": "failed",
            "data": None,
            "error": "Only a single read-only SELECT is allowed",
        }

    aggregate = _AGGREGATE_SELECT_RE.match(statement)
    if aggregate is not None:
        table = aggregate.group("table").lower()
        rest = aggregate.group("rest").strip()
        if table not in _QUERY_DB_ALLOWED_TABLES:
            return {
                "status": "failed",
                "data": None,
                "error": f"Table '{table}' is not accessible",
            }
        if _AGGREGATE_FORBIDDEN_RE.search(rest):
            return {
                "status": "failed",
                "data": None,
                "error": "Unsupported SQL construct",
            }
        if rest:
            where_match = re.match(
                r"^WHERE\s+(?P<where>.+)$", rest, re.IGNORECASE | re.DOTALL
            )
            if not where_match or _AGGREGATE_FORBIDDEN_RE.search(
                where_match.group("where")
            ):
                return {
                    "status": "failed",
                    "data": None,
                    "error": "Only a single WHERE clause is allowed for aggregates",
                }
            scoped = (
                f"SELECT {aggregate.group('agg')} FROM {table} "
                f"WHERE ({where_match.group('where')}) AND organization_id = :org"
            )
        else:
            scoped = (
                f"SELECT {aggregate.group('agg')} FROM {table} "
                "WHERE organization_id = :org"
            )
        try:
            async with engine.connect() as conn:
                result = await conn.execute(text(scoped), {"org": str(org_id)})
                rows = [_jsonable(dict(row._mapping)) for row in result.fetchall()]
            return {"status": "success", "data": rows, "error": None}
        except Exception as exc:  # noqa: BLE001
            return {"status": "failed", "data": None, "error": str(exc)}

    if _FORBIDDEN_SQL_RE.search(statement):
        return {
            "status": "failed",
            "data": None,
            "error": "Unsupported SQL construct",
        }

    parsed = _parse_scoped_select(statement)
    if parsed is None:
        return {
            "status": "failed",
            "data": None,
            "error": "Only single-table SELECT ... FROM <table> [WHERE ...] [LIMIT n] is allowed",
        }

    select_list, table, where_condition, limit_value = parsed
    if table not in _QUERY_DB_ALLOWED_TABLES:
        return {
            "status": "failed",
            "data": None,
            "error": f"Table '{table}' is not accessible",
        }

    if limit_value is None:
        limit_value = _QUERY_DB_MAX_ROWS
    limit_value = min(limit_value, _QUERY_DB_MAX_ROWS)

    scoped = _build_scoped_sql(select_list, table, where_condition, limit_value)
    try:
        async with engine.connect() as conn:
            result = await conn.execute(text(scoped), {"org": str(org_id)})
            rows = [_jsonable(dict(row._mapping)) for row in result.fetchall()]
        return {"status": "success", "data": rows, "error": None}
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "data": None, "error": str(exc)}


def _send_email_sync(to: str, subject: str, body: str) -> dict:
    content_hash = hashlib.sha256(f"{to}\0{subject}\0{body}".encode()).hexdigest()
    with _EMAIL_HASH_LOCK:
        if content_hash in _SENT_EMAIL_HASHES:
            return {"status": "duplicate", "message_id": None}

    message = EmailMessage()
    message["From"] = settings.SMTP_FROM
    message["To"] = to
    message["Subject"] = subject
    message_id = email.utils.make_msgid(domain="agenthub.local")
    message["Message-ID"] = message_id
    message.set_content(body)

    if settings.SMTP_PORT == 465:
        smtp_cls = smtplib.SMTP_SSL
    else:
        smtp_cls = smtplib.SMTP

    with smtp_cls(settings.SMTP_HOST, settings.SMTP_PORT, timeout=30) as smtp:
        if settings.SMTP_PORT != 465 and settings.SMTP_USERNAME:
            smtp.starttls()
        if settings.SMTP_USERNAME:
            smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
        smtp.send_message(message)
    with _EMAIL_HASH_LOCK:
        _SENT_EMAIL_HASHES.add(content_hash)
    return {"status": "success", "message_id": message_id}


@tool
async def send_email(to: str, subject: str, body: str) -> dict:
    """Send an email via the configured provider (SMTP preferred, Resend fallback).

    Requires human approval before execution. 复用系统已有的邮件 Provider 配置，
    不引入新邮件架构。
    """
    try:
        if settings.SMTP_HOST:
            result = await asyncio.to_thread(_send_email_sync, to, subject, body)
        else:
            from app.core.email import send_email as _send_via_email_service

            result = await _send_via_email_service(to, subject, body)
        if result.get("status") == "duplicate":
            return {
                "status": "duplicate",
                "data": {"to": to, "subject": subject},
                "error": None,
            }
        if result.get("ok") is False:
            return {
                "status": "failed",
                "data": None,
                "error": str(result.get("error")),
            }
        message_id = result.get("message_id") or (result.get("data") or {}).get("id")
        return {
            "status": "success",
            "data": {
                "to": to,
                "subject": subject,
                "message_id": message_id,
            },
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "data": None, "error": str(exc)}
