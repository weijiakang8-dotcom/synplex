from __future__ import annotations

import asyncio
import smtplib
import ssl
from email.message import EmailMessage

import httpx

from app.config import settings


def _send_smtp(to: str, subject: str, text: str) -> dict:
    """通过标准库 SMTP 发送邮件，兼容 MailHog 与常见 SMTP 服务商。"""
    try:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = (
            settings.SMTP_FROM or settings.SMTP_USERNAME or "agenthub@local"
        )
        message["To"] = to
        message.set_content(text)

        if settings.SMTP_PORT == 465:
            with smtplib.SMTP_SSL(
                settings.SMTP_HOST, settings.SMTP_PORT, timeout=15
            ) as server:
                if settings.SMTP_USERNAME and settings.SMTP_PASSWORD:
                    server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                server.send_message(message)
        else:
            with smtplib.SMTP(
                settings.SMTP_HOST, settings.SMTP_PORT, timeout=15
            ) as server:
                server.ehlo()
                if settings.SMTP_USERNAME and settings.SMTP_PASSWORD:
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
                    server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                server.send_message(message)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def _send_resend(to: str, subject: str, text: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
                json={
                    "from": settings.RESEND_FROM,
                    "to": [to],
                    "subject": subject,
                    "text": text,
                },
            )
            resp.raise_for_status()
        return {"ok": True, "data": resp.json()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


async def send_email(to: str, subject: str, text: str) -> dict:
    if settings.SMTP_HOST:
        return await asyncio.to_thread(_send_smtp, to, subject, text)
    if settings.RESEND_API_KEY and settings.RESEND_FROM:
        return await _send_resend(to, subject, text)
    return {"ok": False, "error": "email service is not configured"}
