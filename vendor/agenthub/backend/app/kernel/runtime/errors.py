from __future__ import annotations


class RuntimeError(Exception):
    """Kernel Runtime 错误基类。"""


class PlanExecutionFailedError(RuntimeError):
    """Plan 执行失败。"""


__all__ = ["PlanExecutionFailedError", "RuntimeError"]
