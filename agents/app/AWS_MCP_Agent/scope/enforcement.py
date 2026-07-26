"""Operation scope enforcement for AgentCore Gateway tools.

Determines whether a tool invocation is permitted based on the tool name and
the session's operation scope. This module is a pure function layer (no side
effects beyond structured logging) and does NOT inspect chat message content.

Scope rules:
    - "readonly": write-classified tools are rejected; read tools are allowed.
    - "readwrite" / "admin": all tools are allowed.

Write classification uses a conservative verb-matching approach: if ANY known
write verb appears anywhere in the tool name, the tool is classified as a
write operation. Since each Gateway has a single AWS MCP target, tool names
are used as-is without prefix splitting.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

WRITE_VERBS: tuple[str, ...] = (
    "create",
    "update",
    "delete",
    "put",
    "modify",
    "remove",
    "attach",
    "detach",
    "start",
    "stop",
    "terminate",
    "run",
    "enable",
    "disable",
)
"""Verbs that indicate a write/mutating operation.

The list is intentionally broad to be conservative: if in doubt, a tool is
classified as a write operation (fail-safe for readonly sessions).
"""


def is_write_tool(tool_name: str) -> bool:
    """Determine if a tool is a write (mutating) operation based on its name.

    Checks whether any write verb appears as a substring in the lowercased
    tool name. This is a conservative heuristic: ambiguous tools are
    classified as write operations.

    Since each Gateway has a single AWS MCP target, there is no target
    prefix to strip — verb matching operates on the full tool name.

    Args:
        tool_name: The tool name (e.g. "CreateBucket" or "ListBuckets").

    Returns:
        True if the tool is classified as a write operation, False otherwise.
        Returns True for empty tool names (conservative default).
    """
    if not tool_name:
        return True

    lowered = tool_name.lower()

    for verb in WRITE_VERBS:
        if verb in lowered:
            return True

    return False


def is_allowed(tool_name: str, scope: str) -> bool:
    """Determine if a tool invocation is allowed given the operation scope.

    This is a pure function of (tool_name, scope) — it does NOT depend on
    chat message content or any other runtime state.

    Rules:
        - scope "readonly": only non-write tools are allowed.
        - scope "readwrite" or "admin": all tools are allowed.
        - unknown scope values are treated as "readonly" (fail-safe).

    Args:
        tool_name: The full tool name to check.
        scope: The operation scope ("readonly", "readwrite", or "admin").

    Returns:
        True if the tool invocation is permitted, False otherwise.
    """
    normalized_scope = scope.strip().lower() if scope else "readonly"

    if normalized_scope in ("readwrite", "admin"):
        return True

    # For "readonly" (and any unknown scope as fail-safe), reject write tools
    write = is_write_tool(tool_name)

    if write:
        logger.warning(
            "scope_enforcement.rejected",
            extra={
                "tool_name": tool_name,
                "scope": normalized_scope,
                "reason": "write_tool_in_readonly_scope",
            },
        )

    return not write


def build_rejection_message(tool_name: str, scope: str) -> str:
    """Generate a user-facing rejection message for a scope violation.

    The message includes:
    - The rejected operation/tool name
    - The current scope constraint (e.g., "readonly")
    - A suggestion to start a new session with read-write scope

    Args:
        tool_name: The name of the tool that was rejected.
        scope: The current operation scope that caused the rejection.

    Returns:
        A human-readable rejection message suitable for display to the user.
    """
    normalized_scope = scope.strip().lower() if scope else "readonly"

    return (
        f"The operation '{tool_name}' is not permitted in the current "
        f"'{normalized_scope}' session. To perform write operations, "
        f"please start a new session with 'readwrite' scope."
    )
