from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.alerting import _notify
from app.database import master_session_factory
from app.models import AlertEvent, AlertRule, Execution

logger = logging.getLogger(__name__)


async def evaluate_all_rules() -> list[AlertEvent]:
    created: list[AlertEvent] = []
    async with master_session_factory() as session:
        rules = (
            (
                await session.execute(
                    select(AlertRule).where(AlertRule.enabled.is_(True))
                )
            )
            .scalars()
            .all()
        )
        for rule in rules:
            condition = rule.condition or {}
            if condition.get("metric") != "execution_failure_rate":
                continue
            recent = (
                (
                    await session.execute(
                        select(Execution)
                        .order_by(Execution.created_at.desc())
                        .limit(10)
                    )
                )
                .scalars()
                .all()
            )
            if len(recent) < 5:
                continue
            rate = sum(1 for e in recent if e.status == "failed") / len(recent)
            threshold = float(condition.get("threshold", 0.3))
            if rate <= threshold:
                continue

            cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
            existing = (
                await session.execute(
                    select(AlertEvent).where(
                        AlertEvent.rule_id == str(rule.id),
                        AlertEvent.status == "active",
                        AlertEvent.triggered_at > cutoff,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                continue

            alert = AlertEvent(
                rule_id=str(rule.id),
                severity=rule.severity,
                message=f"{rule.name}：执行失败率 {rate:.0%}",
            )
            session.add(alert)
            created.append(alert)
        await session.commit()

    for alert in created:
        await _notify(alert.rule_id, alert.severity, alert.message)
    return created
