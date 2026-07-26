"""Strands tool exposing the safe arithmetic evaluator.

Thin wrapper around :func:`calc.evaluate.safe_eval`, following the same
"pure helper + thin tool wrapper" split as `clock/format.py` + `clock/tool.py`
and `visualization/schema.py` + `visualization/tool.py`. The model uses this
to evaluate arithmetic safely instead of computing it itself (which is
error-prone) -- and the evaluator never uses `eval`/`exec` on the input.

This tool requires no AWS credentials, so it is intentionally NOT part of
`roles.hook.AWS_CREDENTIAL_TOOLS` and is not wrapped by
`RoleSelectingToolWrapper`.
"""

from __future__ import annotations

from typing import Any

from strands import tool

from calc.evaluate import safe_eval

#: The tool name the agent invokes to evaluate an arithmetic expression.
CALCULATE_TOOL_NAME = "calculate"

#: The name carried on the tool result's JSON content block.
CALCULATE_EVENT_NAME = "calculation"

#: Guidance returned to the model when an expression is rejected.
_CALC_GUIDANCE = (
    "Could not evaluate the expression. Only basic arithmetic is supported: "
    "the operators + - * / // % ** and the functions abs, round, min, max "
    "applied to numbers. Names, attribute access, and other function calls "
    "are not allowed."
)


@tool(name=CALCULATE_TOOL_NAME)
def calculate(expression: str) -> dict[str, Any]:
    """Evaluate a basic arithmetic expression safely (use this instead of doing math yourself).

    Supports + - * / // % ** and abs/round/min/max only. Use this whenever you
    need to compute a numeric result (sums, ratios, unit conversions, etc.)
    rather than performing the arithmetic in your head, which is error-prone.

    Args:
        expression: The arithmetic expression to evaluate, e.g. ``"(1 + 2) * 3"``
            or ``"max(4, 7) ** 2"``.

    Returns:
        A Strands ToolResult carrying the expression and its numeric result as
        JSON under the "calculation" name, plus a human-readable
        ``"<expr> = <result>"`` text line. On any invalid or disallowed input,
        an error result explaining what is supported.
    """
    try:
        result = safe_eval(expression)
    except ValueError:
        return {
            "status": "error",
            "content": [{"text": _CALC_GUIDANCE}],
        }

    return {
        "status": "success",
        "content": [
            {
                "json": {
                    "name": CALCULATE_EVENT_NAME,
                    "value": {"expression": expression, "result": result},
                }
            },
            {"text": f"{expression} = {result}"},
        ],
    }
