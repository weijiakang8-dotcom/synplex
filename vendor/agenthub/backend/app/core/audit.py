from __future__ import annotations

import json
from typing import Any

from fastapi import Request

from app.core.request_utils import get_client_ip

SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "code",
    "password",
    "password_hash",
    "refresh_token",
    "secret",
    "token",
    "x-api-key",
}


def _truncate(value: str, limit: int = 2000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "...[truncated]"


def sanitize_audit_data(value: Any, limit: int = 2000) -> Any:
    if isinstance(value, dict):
        return {
            key: (
                "***"
                if str(key).lower() in SENSITIVE_KEYS
                else sanitize_audit_data(item, limit)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_audit_data(item, limit) for item in value]
    if isinstance(value, str):
        return _truncate(value, limit)
    return value


def build_audit_details(request: Request, body: bytes | None) -> dict[str, Any]:
    details: dict[str, Any] = {
        "ip": get_client_ip(request),
        "query_params": sanitize_audit_data(dict(request.query_params)),
    }

    content_type = request.headers.get("content-type", "")
    if body is None:
        details["body"] = {"content_type": content_type or "none"}
        return details

    if "application/json" in content_type:
        try:
            details["body"] = sanitize_audit_data(json.loads(body.decode("utf-8")))
        except Exception:  # noqa: BLE001
            details["body"] = {
                "_raw": _truncate(body.decode("utf-8", errors="ignore")),
            }
    else:
        details["body"] = {
            "content_type": content_type or "none",
            "size": len(body),
        }

    return details


def classify_audit_event(method: str, path: str) -> tuple[str, str | None, str | None]:
    """根据 HTTP 方法与路径，将请求归类为企业审计动作。"""
    method = method.upper()
    parts = [part for part in path.split("/") if part]

    if method == "POST" and len(parts) >= 3 and parts[:2] == ["api", "auth"]:
        return parts[2], "auth", None

    if method == "POST" and parts[:2] == ["api", "executions"]:
        return "create_execution", "execution", None

    if method in {"PUT", "PATCH"} and len(parts) >= 3 and parts[1] == "models":
        return "update_model", "model", parts[2]

    if method == "DELETE" and len(parts) >= 3:
        resource_type = parts[1].rstrip("s")
        return "delete_resource", resource_type, parts[2]

    resource_type = parts[1] if len(parts) > 1 else None
    resource_id = parts[2] if len(parts) > 2 else None
    return f"{method.lower()}_{resource_type or 'request'}", resource_type, resource_id
