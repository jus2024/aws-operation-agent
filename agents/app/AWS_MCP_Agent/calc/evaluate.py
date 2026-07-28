"""Pure, security-hardened arithmetic expression evaluator.

SECURITY-CRITICAL. This module evaluates a *basic arithmetic* expression from
an untrusted source (an LLM-produced string) WITHOUT ever calling
``eval``/``exec``/``compile`` on the input and without touching
``__builtins__``. It parses the expression to an AST via
``ast.parse(..., mode="eval")`` and walks it against an explicit NODE
ALLOWLIST, rejecting anything not on the list (names except a tiny function
allowlist, attribute access, subscripts, arbitrary calls, comprehensions,
lambdas, string/bytes constants, etc.).

It also guards against resource-exhaustion: the expression length is capped,
exponentiation is rejected when the exponent is non-finite or its absolute
value exceeds a small cap, and non-finite results are rejected. Division and
modulo by zero raise a clean ``ValueError`` rather than crashing.

Side-effect-free and deterministic, following the "pure helper + thin tool
wrapper" convention used across this agent.
"""

from __future__ import annotations

import ast
import math
import operator
from collections.abc import Callable

#: Maximum accepted expression length (characters). Longer input is rejected
#: outright to bound parsing/evaluation cost.
_MAX_EXPRESSION_LENGTH = 200

#: Maximum absolute value permitted for a ``**`` exponent, to prevent
#: constructing astronomically large integers (a resource-exhaustion vector).
_MAX_EXPONENT = 100

#: Allowed binary operators, keyed by AST node type.
_BINARY_OPS: dict[type[ast.operator], Callable[[float, float], float]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

#: Allowed unary operators, keyed by AST node type.
_UNARY_OPS: dict[type[ast.unaryop], Callable[[float], float]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

#: Tiny allowlist of pure numeric functions callable from an expression.
_ALLOWED_FUNCS: dict[str, Callable[..., float]] = {
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
}


def safe_eval(expression: str) -> float:
    """Safely evaluate a basic arithmetic expression.

    Supports numeric literals, parentheses, the binary operators
    ``+ - * / // % **``, unary ``+``/``-``, and the functions ``abs``,
    ``round``, ``min``, ``max`` applied to numeric arguments only.

    Args:
        expression: The arithmetic expression to evaluate.

    Returns:
        The numeric result as a float or int (as produced by the operators).

    Raises:
        ValueError: If the expression is not a string, is empty, is too long,
            fails to parse, contains any disallowed construct, exceeds the
            exponent cap, divides/mods by zero, or produces a non-finite
            result.
    """
    if not isinstance(expression, str):
        raise ValueError("expression must be a string")

    stripped = expression.strip()
    if not stripped:
        raise ValueError("expression must not be empty")
    if len(stripped) > _MAX_EXPRESSION_LENGTH:
        raise ValueError(
            f"expression is too long (max {_MAX_EXPRESSION_LENGTH} characters)"
        )

    try:
        tree = ast.parse(stripped, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"could not parse expression: {exc}") from exc

    result = _eval_node(tree.body)

    if isinstance(result, bool) or not isinstance(result, (int, float)):
        raise ValueError("expression did not evaluate to a number")
    if not math.isfinite(result):
        raise ValueError("expression produced a non-finite result")
    return result


def _eval_node(node: ast.AST) -> float:
    """Recursively evaluate an allowlisted AST node.

    Raises:
        ValueError: On any node type or content outside the allowlist.
    """
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("only numeric constants are allowed")
        return node.value

    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        func = _BINARY_OPS.get(op_type)
        if func is None:
            raise ValueError(f"operator {op_type.__name__} is not allowed")
        left = _eval_node(node.left)
        right = _eval_node(node.right)
        return _apply_binary(op_type, func, left, right)

    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        func = _UNARY_OPS.get(op_type)
        if func is None:
            raise ValueError(f"unary operator {op_type.__name__} is not allowed")
        return func(_eval_node(node.operand))

    if isinstance(node, ast.Call):
        return _eval_call(node)

    raise ValueError(f"{type(node).__name__} is not allowed in an expression")


def _apply_binary(
    op_type: type[ast.operator],
    func: Callable[[float, float], float],
    left: float,
    right: float,
) -> float:
    """Apply a binary operator with division/exponent guards.

    Raises:
        ValueError: On division/modulo by zero or an out-of-range exponent.
    """
    if op_type is ast.Pow:
        if isinstance(right, bool) or not isinstance(right, (int, float)):
            raise ValueError("exponent must be a number")
        if not math.isfinite(right) or abs(right) > _MAX_EXPONENT:
            raise ValueError(f"exponent must be finite and at most {_MAX_EXPONENT}")

    if op_type in (ast.Div, ast.FloorDiv, ast.Mod) and right == 0:
        raise ValueError("division or modulo by zero")

    return func(left, right)


def _eval_call(node: ast.Call) -> float:
    """Evaluate a call to an allowlisted bare function name.

    Rejects keyword arguments, starred arguments, and any callable that is
    not a bare ``Name`` in the function allowlist.

    Raises:
        ValueError: On any disallowed call shape or unknown function.
    """
    if not isinstance(node.func, ast.Name):
        raise ValueError("only calls to allowed functions by name are permitted")
    func_name = node.func.id
    func = _ALLOWED_FUNCS.get(func_name)
    if func is None:
        raise ValueError(f"function {func_name!r} is not allowed")
    if node.keywords:
        raise ValueError("keyword arguments are not allowed")
    for arg in node.args:
        if isinstance(arg, ast.Starred):
            raise ValueError("starred arguments are not allowed")

    args = [_eval_node(arg) for arg in node.args]
    if not args:
        raise ValueError(f"{func_name}() requires at least one numeric argument")
    return func(*args)
