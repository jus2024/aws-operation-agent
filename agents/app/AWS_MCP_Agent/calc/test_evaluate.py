"""Unit tests for the safe arithmetic evaluator (calc/evaluate.py) and tool.

SECURITY-CRITICAL: these tests assert both correct arithmetic AND that
dangerous/disallowed constructs are rejected with ValueError. Deterministic
and offline.
"""

from __future__ import annotations

import pytest

from calc.evaluate import safe_eval
from calc.tool import CALCULATE_EVENT_NAME, calculate


def test_basic_addition() -> None:
    assert safe_eval("1 + 2") == 3


def test_operator_precedence() -> None:
    assert safe_eval("1 + 2 * 3") == 7
    assert safe_eval("(1 + 2) * 3") == 9


def test_all_binary_operators() -> None:
    assert safe_eval("10 - 4") == 6
    assert safe_eval("6 * 7") == 42
    assert safe_eval("7 / 2") == 3.5
    assert safe_eval("7 // 2") == 3
    assert safe_eval("7 % 3") == 1
    assert safe_eval("2 ** 10") == 1024


def test_unary_operators() -> None:
    assert safe_eval("-5") == -5
    assert safe_eval("+5") == 5
    assert safe_eval("-(2 + 3)") == -5


def test_allowed_functions() -> None:
    assert safe_eval("abs(-7)") == 7
    assert safe_eval("round(3.14159, 2)") == 3.14
    assert safe_eval("min(4, 7)") == 4
    assert safe_eval("max(4, 7)") == 7


def test_float_result() -> None:
    assert safe_eval("1.5 + 2.25") == 3.75


@pytest.mark.parametrize(
    "expr",
    [
        '__import__("os")',
        "os.system('ls')",
        "x",
        "abs.__class__",
        "[i for i in range(3)]",
        "lambda: 1",
        "'string'",
        "b'bytes'",
        "len([1, 2])",
        "print(1)",
    ],
)
def test_rejects_disallowed_constructs(expr: str) -> None:
    with pytest.raises(ValueError):
        safe_eval(expr)


def test_rejects_exponent_over_cap() -> None:
    with pytest.raises(ValueError):
        safe_eval("2 ** 100000")


def test_rejects_overly_long_expression() -> None:
    long_expr = "+".join(["1"] * 300)
    with pytest.raises(ValueError):
        safe_eval(long_expr)


def test_division_by_zero_raises() -> None:
    with pytest.raises(ValueError):
        safe_eval("1 / 0")
    with pytest.raises(ValueError):
        safe_eval("1 % 0")
    with pytest.raises(ValueError):
        safe_eval("1 // 0")


def test_empty_and_non_string() -> None:
    with pytest.raises(ValueError):
        safe_eval("")
    with pytest.raises(ValueError):
        safe_eval(123)  # type: ignore[arg-type]


def test_tool_success_shape() -> None:
    result = calculate("(1 + 2) * 3")
    assert result["status"] == "success"
    json_block = [c["json"] for c in result["content"] if "json" in c][0]
    assert json_block["name"] == CALCULATE_EVENT_NAME
    assert json_block["value"] == {"expression": "(1 + 2) * 3", "result": 9}
    text = [c["text"] for c in result["content"] if "text" in c][0]
    assert text == "(1 + 2) * 3 = 9"


def test_tool_error_on_disallowed() -> None:
    result = calculate('__import__("os").system("ls")')
    assert result["status"] == "error"
    assert result["content"][0]["text"]


def test_tool_error_on_div_by_zero() -> None:
    result = calculate("1 / 0")
    assert result["status"] == "error"
