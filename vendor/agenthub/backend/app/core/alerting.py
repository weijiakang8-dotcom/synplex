from __future__ import annotations

import asyncio
import logging

import httpx
from sqlalchemy import select

from app.config import settings
from app.core.circuit_breaker import llm_breaker
from app.database import master_session_factory
from app.models import AlertEvent, Execution

logger = logging.getLogger(__name__)


async def _notify(rule_id: str, severity: str, message: str) -> None:
    webhook = (
        settings.ALERT_WEBHOOK_URL if hasattr(settings, "ALERT_WEBHOOK_URL") else ""
    )
    if not webhook:
        return
    payload = {"rule_id": rule_id, "severity": severity, "message": message}
    for _ in range(2):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(webhook, json=payload)
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("alert webhook failed: %s", exc)
            await asyncio.sleep(1)


async def evaluate_alert_rules() -> list[AlertEvent]:
    alerts: list[AlertEvent] = []
    async with master_session_factory() as session:
        recent = (
            (
                await session.execute(
                    select(Execution).order_by(Execution.created_at.desc()).limit(20)
                )
            )
            .scalars()
            .all()
        )

        if len(recent) >= 10:
            failed = [e for e in recent[:10] if e.status == "failed"]
            if len(failed) / 10 > 0.3:
                alerts.append(
                    AlertEvent(
                        rule_id="failure_rate",
                        severity="critical",
                        message=f"最近 10 次执行失败率 {len(failed) * 10}%",
                    )
                )

        if llm_breaker.state == "OPEN":
            alerts.append(
                AlertEvent(
                    rule_id="circuit_open",
                    severity="critical",
                    message="LLM 熔断器进入 OPEN 状态",
                )
            )

        for alert in alerts:
            session.add(alert)
        await session.commit()

    for alert in alerts:
        await _notify(alert.rule_id, alert.severity, alert.message)
    return alerts
