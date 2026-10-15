"""全局唯一参数规范化（Phase 6A Frozen Contract）。

Approval 参数冻结与 Idempotency key 必须共用本模块，禁止第二份实现。

规则：
1. 按 tool schema 校验（缺失/额外键）；
2. 删除值为 null 的键；
3. key 按字典序排序；
4. JSON stable serialization；
5. 数值/字符串按 JSON 语义统一（1 == 1.0，1 != "1"）。
"""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Any

from app.engine.tool_registry import get_tool


def _canonical_number(value: Any) -> int | float | str:
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return str(value)
    if decimal_value == decimal_value.to_integral_value():
        return int(decimal_value)
    return float(decimal_value)


def _canonical_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return _canonical_number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): _canonical_value(item)
            for key, item in value.items()
            if item is not None
        }
    return str(value)


def validate_tool_params(tool_name: str | None, params: dict[str, Any]) -> list[str]:
    """按 tool schema 校验：required 必须存在且非 null；不允许额外键。"""
    if not tool_name:
        return []
    spec = get_tool(tool_name)
    if spec is None or not isinstance(spec.parameters, dict):
        return []
    schema = spec.parameters
    properties = schema.get("properties") or {}
    required = schema.get("required") or []
    errors: list[str] = []
    for key in required:
        if key not in params or params.get(key) is None:
            errors.append(f"missing required parameter: {key}")
    for key, value in params.items():
        if key not in properties and value is not None:
            errors.append(f"extra parameter not allowed by schema: {key}")
    return errors


def params_canonical(params: dict[str, Any], tool_name: str | None = None) -> str:
    """返回规范化后的稳定 JSON 字符串。"""
    canonical_dict = _canonical_value(params or {})
    return json.dumps(
        canonical_dict,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def tool_params_match(
    frozen_canonical: str,
    tool_name: str,
    params: dict[str, Any],
) -> bool:
    """实际执行参数是否与冻结提案一致。"""
    return params_canonical(params, tool_name=tool_name) == frozen_canonical


__all__ = [
    "params_canonical",
    "tool_params_match",
    "validate_tool_params",
]
