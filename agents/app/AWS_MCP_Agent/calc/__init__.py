"""Safe arithmetic evaluation for the AWS MCP Agent.

Exposes a pure, security-hardened arithmetic evaluator (`calc.evaluate`) and
the Strands tool (`calc.tool`) the agent calls to compute basic arithmetic
instead of doing math itself. The evaluator uses an explicit AST node
allowlist and never touches `eval`/`exec`/`compile` on the expression or
`__builtins__`. Follows the same "pure helper module + thin tool wrapper"
split used by the `clock`, `units`, and `visualization` packages.
"""

from calc.evaluate import safe_eval
from calc.tool import CALCULATE_EVENT_NAME, CALCULATE_TOOL_NAME

__all__ = [
    "CALCULATE_EVENT_NAME",
    "CALCULATE_TOOL_NAME",
    "safe_eval",
]
