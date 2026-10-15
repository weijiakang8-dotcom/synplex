"""统一错误分类与重试策略（Frozen Core）。

所有层的重试都必须先经过 ErrorCategory 判定：
- TRANSIENT / TIMEOUT / PROVIDER：LLM 与 Provider 层处理；
- INFRASTRUCTURE：Celery 层处理；
- PERMANENT / BUSINESS / APPROVAL：一律不重试。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import StrEnum


class ErrorCategory(StrEnum):
    TRANSIENT = "transient"
    TIMEOUT = "timeout"
    PROVIDER = "provider"
    INFRASTRUCTURE = "infrastructure"
    PERMANENT = "permanent"
    BUSINESS = "business"
    APPROVAL = "approval"


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int
    backoff_base: float = 2.0
    max_delay: float = 30.0

    def delay(self, attempt: int) -> float:
        return min(self.backoff_base**attempt, self.max_delay)


# 每层职责边界：Celery 只重试基础设施故障，LLM 层处理上游瞬态错误。
LLM_RETRY_POLICY = RetryPolicy(max_attempts=3)
TOOL_RETRY_POLICY = RetryPolicy(max_attempts=3)
CELERY_RETRY_POLICY = RetryPolicy(max_attempts=3)


def classify_error(exc: BaseException) -> ErrorCategory:
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return ErrorCategory.TIMEOUT
    text = str(exc).lower()
    if any(
        marker in text
        for marker in (
            "approval",
            "rejected",
            "requires approval",
            "not approved",
        )
    ):
        return ErrorCategory.APPROVAL
    if any(
        marker in text
        for marker in (
            "database unavailable",
            "connection refused",
            "cannot connect",
            "broker unavailable",
            "task broker",
        )
    ):
        return ErrorCategory.INFRASTRUCTURE
    if any(
        marker in text
        for marker in (
            "rate limit",
            "too many requests",
            "overloaded",
            "temporarily",
            "service unavailable",
            "server error",
            "5xx",
            "timeout",
            "timed out",
        )
    ):
        return ErrorCategory.PROVIDER
    if any(
        marker in text
        for marker in (
            "connection",
            "network",
            "reset by peer",
            "broken pipe",
        )
    ):
        return ErrorCategory.TRANSIENT
    if any(
        marker in text
        for marker in (
            "validation",
            "invalid",
            "not found",
            "unsupported",
            "bad request",
            "permission",
            "denied",
            "duplicate",
        )
    ):
        return ErrorCategory.PERMANENT
    return ErrorCategory.BUSINESS


def should_retry(category: ErrorCategory, layer: str) -> bool:
    """按层决定是否重试，避免跨层指数级叠加。"""
    if layer == "llm":
        return category in {
            ErrorCategory.TRANSIENT,
            ErrorCategory.TIMEOUT,
            ErrorCategory.PROVIDER,
        }
    if layer == "tool":
        return category in {ErrorCategory.TRANSIENT, ErrorCategory.TIMEOUT}
    if layer == "celery":
        return category in {ErrorCategory.INFRASTRUCTURE, ErrorCategory.TRANSIENT}
    return False


__all__ = [
    "CELERY_RETRY_POLICY",
    "LLM_RETRY_POLICY",
    "TOOL_RETRY_POLICY",
    "ErrorCategory",
    "RetryPolicy",
    "classify_error",
    "should_retry",
]
