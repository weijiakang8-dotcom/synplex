from __future__ import annotations


class GoalError(Exception):
    """Kernel Goal 语义层错误基类。"""


class UnknownGoalPredicateError(GoalError):
    """引用了未注册的 Goal Predicate。"""


class UnknownConstraintError(GoalError):
    """引用了未注册的 Constraint。"""


__all__ = ["GoalError", "UnknownConstraintError", "UnknownGoalPredicateError"]
