from __future__ import annotations


class PlanValidationError(Exception):
    """Plan 校验失败。"""


class CycleDetectedError(PlanValidationError):
    """Plan 依赖图中存在环。"""


__all__ = ["CycleDetectedError", "PlanValidationError"]
