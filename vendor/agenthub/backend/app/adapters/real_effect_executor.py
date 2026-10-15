from __future__ import annotations

import asyncio
import os
import smtplib
from email.message import EmailMessage

import httpx

from app.core.safe_outbound import request_public
from app.kernel.effects.command import Command
from app.kernel.effects.port import EffectResult


class RealEffectExecutor:
    """真实外部 I/O 执行器（HTTP / SMTP）。Kernel 不 import 本模块。"""

    def __init__(self, retry_policy=None) -> None:
        from app.kernel.effects.retry import RetryPolicy

        self._retry_policy = retry_policy or RetryPolicy(max_retries=1)

    async def execute(self, command: Command) -> EffectResult:
        if command.capability_id == "observe":
            return await self._http(command)
        if command.capability_id == "mutate":
            if command.payload.get("transport", "smtp") == "http":
                return await self.post_effect(command)
            return await self._smtp(command)
        return EffectResult(
            status="error",
            committed=False,
            error=f"unsupported capability: {command.capability_id}",
        )

    def execute_effect(self, command: Command) -> EffectResult:
        import asyncio

        return asyncio.run(self.execute(command))

    def query_effect(
        self,
        command: Command,
        external_reference: str | None = None,
    ) -> EffectResult:
        import asyncio

        return asyncio.run(self._query(command, external_reference))

    def can_retry(self, attempt_count: int) -> bool:
        return self._retry_policy.eligible(attempt_count)

    def build_retry_command(self, original: Command, attempt: int) -> Command:
        return self._retry_policy.build_retry_command(original, attempt)

    async def _query(
        self,
        command: Command,
        external_reference: str | None = None,
    ) -> EffectResult:
        if command.capability_id == "mutate":
            if command.payload.get("transport", "smtp") == "http":
                return await self.query_operation(
                    external_reference or command.payload.get("operation_id"),
                    command.payload.get("base_url") or self._http_base_url(command),
                )
            return await self._query_mailhog(command, external_reference)
        if command.capability_id == "observe":
            return await self._http(command)
        return EffectResult(
            status="error", committed=None, error="unsupported capability"
        )

    @staticmethod
    def _http_base_url(command: Command) -> str:
        url = command.payload.get("url") or ""
        return url.split("/api/external/effect", 1)[0]

    async def _query_mailhog(
        self,
        command: Command,
        message_id: str | None = None,
    ) -> EffectResult:
        api = os.getenv("MAILHOG_API", "http://127.0.0.1:8025")
        message_id = message_id or command.payload.get("message_id")
        if not message_id:
            return EffectResult(
                status="unknown", committed=None, error="missing message_id"
            )
        try:
            found = False
            for _ in range(3):
                async with httpx.AsyncClient(timeout=10) as client:
                    response = await client.get(f"{api}/api/v2/messages")
                data = response.json()
                found = any(
                    message_id
                    in (
                        item.get("Content", {}).get("Headers", {}).get("Message-ID")
                        or ""
                    )
                    for item in data.get("items", [])
                )
                if found:
                    break
                await asyncio.sleep(0.5)
            return EffectResult(
                status="success",
                committed=bool(found),
                external_reference=message_id,
                raw_response={"found": found},
            )
        except Exception as exc:  # noqa: BLE001
            return EffectResult(status="unknown", committed=None, error=str(exc))

    async def post_effect(self, command: Command) -> EffectResult:
        """真实 POST 外部 effect；按 payload.timeout_ms 触发客户端超时。"""
        url = command.payload.get("url")
        timeout_ms = int(command.payload.get("timeout_ms", 10000))
        if not url:
            return EffectResult(status="error", committed=False, error="missing url")
        body = {
            "operation_id": command.payload.get("operation_id"),
            "idempotency_key": command.idempotency_key,
            "mode": command.payload.get("mode", "success"),
            "delay_ms": int(command.payload.get("delay_ms", 0)),
        }
        try:
            async with httpx.AsyncClient(
                timeout=timeout_ms / 1000, follow_redirects=False
            ) as client:
                response = await request_public(client, "POST", url, json=body)
            data = response.json()
            committed = data.get("committed")
            if data.get("status") == "duplicate":
                return EffectResult(
                    status="duplicate",
                    committed=committed,
                    external_reference=data.get("operation_id"),
                    raw_response=data,
                )
            return EffectResult(
                status="success" if response.status_code == 200 else "unknown",
                committed=committed,
                external_reference=data.get("operation_id"),
                raw_response=data,
            )
        except httpx.TimeoutException as exc:
            return EffectResult(
                status="timeout",
                committed=None,
                external_reference=command.payload.get("operation_id"),
                error=str(exc),
            )
        except Exception as exc:  # noqa: BLE001
            return EffectResult(status="error", committed=None, error=str(exc))

    async def query_operation(self, operation_id: str, base_url: str) -> EffectResult:
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                response = await request_public(
                    client,
                    "GET",
                    f"{base_url}/api/external/effect/{operation_id}",
                )
            data = response.json()
            committed = data.get("committed")
            return EffectResult(
                status="success",
                committed=committed,
                external_reference=operation_id,
                raw_response=data,
            )
        except Exception as exc:  # noqa: BLE001
            return EffectResult(status="error", committed=None, error=str(exc))

    async def _http(self, command: Command) -> EffectResult:
        url = command.payload.get("url")
        if not url:
            return EffectResult(status="error", committed=False, error="missing url")
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                params = command.payload.get("params")
                response = await request_public(client, "GET", url, params=params)
            if response.status_code == 200:
                return EffectResult(
                    status="success",
                    committed=True,
                    external_reference=response.headers.get("x-request-id"),
                    raw_response=response.json(),
                )
            if response.status_code == 202:
                return EffectResult(
                    status="unknown",
                    committed=None,
                    external_reference=response.headers.get("x-request-id"),
                    raw_response=response.text,
                )
            return EffectResult(
                status="error",
                committed=False,
                raw_response=response.text,
            )
        except httpx.TimeoutException as exc:
            return EffectResult(status="timeout", committed=None, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            return EffectResult(status="error", committed=None, error=str(exc))

    async def _smtp(self, command: Command) -> EffectResult:
        to = command.payload.get("to")
        subject = command.payload.get("subject")
        body = command.payload.get("body")
        if not to or not subject or not body:
            return EffectResult(
                status="error",
                committed=False,
                error="missing to/subject/body",
            )

        message = EmailMessage()
        message["From"] = os.getenv("SMTP_FROM", "agenthub@local")
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)
        explicit_message_id = command.payload.get("message_id")
        if explicit_message_id:
            message["Message-ID"] = explicit_message_id

        host = os.getenv("SMTP_HOST", "127.0.0.1")
        port = int(os.getenv("SMTP_PORT", "1025"))
        try:
            with smtplib.SMTP(host, port, timeout=10) as smtp:
                smtp.send_message(message)
            return EffectResult(
                status="success",
                committed=None,
                external_reference=message["Message-ID"],
            )
        except Exception as exc:  # noqa: BLE001
            return EffectResult(status="error", committed=False, error=str(exc))


__all__ = ["EffectResult", "RealEffectExecutor"]
