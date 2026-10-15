from __future__ import annotations

import asyncio
import re
import smtplib
from email.message import EmailMessage
from typing import Any

import httpx

from app.config import settings
from app.core.safe_outbound import request_public
from app.database import async_session_factory
from app.models import Notification

TEMPLATES: dict[str, str] = {
    "execution_completed": "执行完成：{{execution_id}}，状态：{{status}}",
    "alert": "告警：{{message}}",
}


def render_template(template: str, params: dict[str, Any]) -> str:
    text = TEMPLATES.get(template, TEMPLATES.get("alert", template))
    for key, value in params.items():
        text = re.sub(r"\{\{\s*" + re.escape(key) + r"\s*\}\}", str(value), text)
    return text


async def _send_email(to: str, subject: str, body: str) -> None:
    message = EmailMessage()
    message["From"] = settings.SMTP_FROM
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    if settings.SMTP_PORT == 465:
        with smtplib.SMTP_SSL(
            settings.SMTP_HOST, settings.SMTP_PORT, timeout=30
        ) as smtp:
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=30) as smtp:
            smtp.starttls()
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            smtp.send_message(message)


async def _send_webhook(url: str, payload: dict[str, Any]) -> None:
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        response = await request_public(client, "POST", url, json=payload)
        response.raise_for_status()


async def _dispatch(channel: str, text: str, params: dict[str, Any]) -> None:
    if channel == "email":
        to = params.get("to") or settings.SMTP_FROM
        await _send_email(to, params.get("subject") or "AgentHub Notification", text)
    elif channel in {"webhook", "feishu", "dingtalk", "wecom"}:
        url = (
            params.get("webhook")
            or settings.FEISHU_WEBHOOK_URL
            or settings.ALERT_WEBHOOK_URL
        )
        if not url:
            raise RuntimeError(f"{channel} webhook is not configured")
        payload = {"msg_type": "text", "text": {"content": text}}
        await _send_webhook(url, payload)
    else:
        raise ValueError(f"Unsupported channel: {channel}")


async def send_notification(
    channel: str,
    template: str,
    params: dict[str, Any],
    organization_id: str | None = None,
) -> dict:
    text = render_template(template, params)
    record = Notification(
        organization_id=organization_id,
        channel=channel,
        template=template,
        params=params,
        status="pending",
    )
    async with async_session_factory() as session:
        session.add(record)
        await session.commit()
        await session.refresh(record)

    last_error = ""
    for _ in range(3):
        try:
            await _dispatch(channel, text, params)
            status = "success"
            last_error = ""
            break
        except Exception as exc:  # noqa: BLE001
            status = "failed"
            last_error = str(exc)
            await asyncio.sleep(1)

    async with async_session_factory() as session:
        record = await session.get(Notification, record.id)
        record.status = status
        record.error = last_error
        await session.commit()

    return {"status": status, "error": last_error}
