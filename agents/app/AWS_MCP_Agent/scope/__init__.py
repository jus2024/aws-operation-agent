"""Operation scope enforcement module.

Provides pure functions to determine whether a tool invocation is allowed
based on the operation scope assigned to the current session.
"""

from scope.enforcement import build_rejection_message, is_allowed, is_write_tool

__all__ = ["build_rejection_message", "is_allowed", "is_write_tool"]
