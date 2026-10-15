from __future__ import annotations


class AdapterError(Exception):
    """Adapter 层错误基类。"""


class InvalidLegacyToolError(AdapterError):
    """Legacy Tool 数据不完整，无法安全生成 Kernel 契约。"""


class UnsupportedKernelWorkflowError(AdapterError):
    """Workflow 不能被 KernelRuntime production path 安全执行。"""


__all__ = [
    "AdapterError",
    "InvalidLegacyToolError",
    "UnsupportedKernelWorkflowError",
]
