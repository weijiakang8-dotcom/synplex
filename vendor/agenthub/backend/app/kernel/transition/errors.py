from __future__ import annotations


class TransitionError(Exception):
    """Kernel Transition 语义层错误基类。"""


class InvalidTaskError(TransitionError):
    """Task 不合法。"""


__all__ = ["InvalidTaskError", "TransitionError"]
