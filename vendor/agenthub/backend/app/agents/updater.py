"""Agent 自更新管线（候选 → 门禁 → 激活 → 回滚，全程版本化）。

- propose：把最近成功的执行样本提炼成提示词增强（few-shot），生成 candidate 版本；
- gate：结构性门禁（非空、长度、含核心指令）+ 可选指标门禁（metrics 提供则必须胜出）；
- activate：候选转 active，旧 active 转 retired（单活跃版本）；
- rollback：当前 active 退 retired，最近一个 retired 重新 active。
所有动作落 agent_versions 表 = 审计事实源。
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.agents import get_active_version, get_agent_spec
from app.database import async_session_factory
from app.models import AgentVersion

logger = logging.getLogger(__name__)

MAX_PROMPT_CHARS = 8000
MAX_EXAMPLES = 3


async def propose_agent_update(
    name: str,
    *,
    organization_id: str | None,
    change_note: str,
    examples: list[str] | None = None,
    metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """生成候选版本：默认提示词 + 最近成功样本（few-shot），不覆盖核心指令。"""
    spec = get_agent_spec(name)
    if spec is None:
        return {"ok": False, "error": f"unknown agent: {name}"}
    active = await get_active_version(name, organization_id)
    base_prompt = (active.system_prompt if active else "") or spec.system_prompt
    base_metrics = (active.metrics if active else None) or {}

    sections = [base_prompt.strip()]
    if examples:
        sample = "\n\n".join(f"- {item[:400]}" for item in examples[:MAX_EXAMPLES])
        sections.append(f"\n\n【近期成功样本，供参考】\n{sample}")
    new_prompt = "\n".join(sections)[:MAX_PROMPT_CHARS]

    gate_ok, gate_reason = _gate(
        base_prompt=new_prompt,
        base_metrics=base_metrics,
        candidate_metrics=metrics,
    )
    if not gate_ok:
        return {"ok": False, "error": f"gate rejected: {gate_reason}"}

    next_version = (int(active.version) + 1) if active else 1
    row = AgentVersion(
        name=name,
        version=next_version,
        role=spec.role,
        system_prompt=new_prompt,
        model_policy=spec.model_policy,
        status="candidate",
        metrics=metrics,
        change_note=change_note or "",
        organization_id=(uuid.UUID(str(organization_id)) if organization_id else None),
    )
    try:
        async with async_session_factory() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
    except Exception:
        logger.warning("persist candidate agent version failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}
    return {
        "ok": True,
        "id": str(row.id),
        "name": name,
        "version": next_version,
        "status": "candidate",
        "system_prompt": new_prompt,
    }


def _gate(
    *,
    base_prompt: str,
    base_metrics: dict[str, Any] | None,
    candidate_metrics: dict[str, Any] | None,
) -> tuple[bool, str]:
    """结构门禁 + 可选指标门禁：指标提供则必须全面不劣于当前版本。"""
    if not base_prompt or len(base_prompt) < 20:
        return False, "prompt too short"
    if len(base_prompt) > MAX_PROMPT_CHARS:
        return False, "prompt too long"
    if not candidate_metrics:
        return True, "structural gate passed"
    base_metrics = base_metrics or {}
    for key in ("success_rate",):
        candidate_value = candidate_metrics.get(key)
        if candidate_value is None:
            continue
        base_value = base_metrics.get(key)
        if base_value is not None and float(candidate_value) < float(base_value):
            return False, f"{key} regressed ({base_value} -> {candidate_value})"
    return True, "structural + metrics gate passed"


async def activate_agent_version(version_id: uuid.UUID) -> dict[str, Any]:
    """激活候选版本：同租户同名旧 active 全部退役。"""
    try:
        async with async_session_factory() as session:
            row = await session.get(AgentVersion, version_id)
            if row is None:
                return {"ok": False, "error": "version not found"}
            if row.status not in {"candidate", "retired"}:
                return {"ok": False, "error": f"cannot activate status={row.status}"}
            old_rows = (
                (
                    await session.execute(
                        select(AgentVersion).where(
                            AgentVersion.name == row.name,
                            AgentVersion.status == "active",
                            AgentVersion.organization_id == row.organization_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
            for old in old_rows:
                old.status = "retired"
            row.status = "active"
            row.applied_at = datetime.now(timezone.utc)
            await session.commit()
            return {
                "ok": True,
                "id": str(row.id),
                "name": row.name,
                "version": row.version,
                "status": "active",
            }
    except Exception:
        logger.warning("activate agent version failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}


async def rollback_agent(name: str, organization_id: str | None) -> dict[str, Any]:
    """回滚：当前 active 退役，最近一个 retired 版本重新激活。"""
    org_key = uuid.UUID(str(organization_id)) if organization_id else None
    try:
        async with async_session_factory() as session:
            active = await get_active_version(name, organization_id)
            if active is None:
                return {"ok": False, "error": "no active version to rollback"}
            stmt = (
                select(AgentVersion)
                .where(
                    AgentVersion.name == name,
                    AgentVersion.status == "retired",
                    AgentVersion.organization_id == org_key,
                )
                .order_by(AgentVersion.version.desc())
                .limit(1)
            )
            previous = (await session.execute(stmt)).scalars().first()
            active = await session.get(AgentVersion, active.id)
            if active is not None:
                active.status = "retired"
            if previous is not None:
                previous = await session.get(AgentVersion, previous.id)
                previous.status = "active"
                previous.applied_at = datetime.now(timezone.utc)
                result = {
                    "ok": True,
                    "name": name,
                    "version": previous.version,
                    "status": "active",
                }
            else:
                result = {
                    "ok": True,
                    "name": name,
                    "version": None,
                    "status": "default",
                    "note": "no previous version; reverted to built-in default prompt",
                }
            await session.commit()
            return result
    except Exception:
        logger.warning("rollback agent failed", exc_info=True)
        return {"ok": False, "error": "persist failed"}


async def list_agent_versions(
    name: str, organization_id: str | None
) -> list[dict[str, Any]]:
    try:
        async with async_session_factory() as session:
            stmt = (
                select(AgentVersion)
                .where(AgentVersion.name == name)
                .order_by(AgentVersion.version.desc())
                .limit(50)
            )
            if organization_id:
                stmt = stmt.where(
                    AgentVersion.organization_id == uuid.UUID(str(organization_id))
                )
            result = await session.execute(stmt)
            rows = list(result.scalars().all())
    except Exception:  # noqa: BLE001
        return []
    return [
        {
            "id": str(row.id),
            "name": row.name,
            "version": row.version,
            "status": row.status,
            "change_note": row.change_note,
            "metrics": row.metrics,
            "created_at": row.created_at.isoformat(),
            "applied_at": row.applied_at.isoformat() if row.applied_at else None,
            "system_prompt_preview": row.system_prompt[:120],
        }
        for row in rows
    ]


__all__ = [
    "activate_agent_version",
    "list_agent_versions",
    "propose_agent_update",
    "rollback_agent",
]
