from __future__ import annotations

import ast
import operator
from typing import Any

ALLOWED_NAMES = {"final_output", "messages", "node_outputs"}
ALLOWED_FUNCS = {
    "len": len,
    "int": int,
    "str": str,
    "float": float,
}

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
}

_UNARY_OPS = {
    ast.Not: operator.not_,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

_CMP_OPS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.In: lambda left, right: left in right,
    ast.NotIn: lambda left, right: left not in right,
}


class UnsafeExpressionError(ValueError):
    """表达式包含安全白名单之外的结构。"""


def _eval_node(node: ast.AST, context: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body, context)

    if isinstance(node, ast.Constant):
        return node.value

    if isinstance(node, ast.Name):
        if node.id not in ALLOWED_NAMES:
            raise UnsafeExpressionError(f"forbidden name: {node.id}")
        return context[node.id]

    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            for value in node.values:
                if not _eval_node(value, context):
                    return False
            return True
        if isinstance(node.op, ast.Or):
            for value in node.values:
                if _eval_node(value, context):
                    return True
            return False
        raise UnsafeExpressionError("unsupported bool operator")

    if isinstance(node, ast.BinOp):
        handler = _BIN_OPS.get(type(node.op))
        if handler is None:
            raise UnsafeExpressionError("unsupported binary operator")
        return handler(
            _eval_node(node.left, context),
            _eval_node(node.right, context),
        )

    if isinstance(node, ast.UnaryOp):
        handler = _UNARY_OPS.get(type(node.op))
        if handler is None:
            raise UnsafeExpressionError("unsupported unary operator")
        return handler(_eval_node(node.operand, context))

    if isinstance(node, ast.Compare):
        left = _eval_node(node.left, context)
        for op_node, comparator in zip(node.ops, node.comparators):
            handler = _CMP_OPS.get(type(op_node))
            if handler is None:
                raise UnsafeExpressionError("unsupported comparison")
            right = _eval_node(comparator, context)
            if not handler(left, right):
                return False
            left = right
        return True

    if isinstance(node, ast.Subscript):
        value = _eval_node(node.value, context)
        if isinstance(node.slice, ast.Index):
            index = _eval_node(node.slice.value, context)
        elif isinstance(node.slice, ast.Constant):
            index = node.slice.value
        else:
            raise UnsafeExpressionError("unsupported subscript")
        return value[index]

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise UnsafeExpressionError("only whitelisted functions may be called")
        function_name = node.func.id
        if function_name not in ALLOWED_FUNCS or node.keywords:
            raise UnsafeExpressionError(f"forbidden function: {function_name}")
        args = [_eval_node(arg, context) for arg in node.args]
        return ALLOWED_FUNCS[function_name](*args)

    raise UnsafeExpressionError(f"unsupported AST node: {type(node).__name__}")


def evaluate_condition(expression: str | None, context: dict[str, Any]) -> bool:
    """安全地评估工作流条件表达式。

    空表达式视为 True；任何非法表达式或运行时错误都返回 False，
    避免因为用户输入的条件导致服务崩溃或任意代码执行。
    """
    if expression is None or not str(expression).strip():
        return True

    try:
        tree = ast.parse(str(expression), mode="eval")
        return bool(_eval_node(tree, context))
    except Exception:  # noqa: BLE001
        return False
