"""BeforeToolCallEvent hook: scope enforcement + aws_profile injection/rejection.

This module implements the single shared Strands hook that is registered once
on the template Agent (see main.py, task 7.1) and therefore runs for every
tool call in every session. It has two responsibilities, both delegated to a
single `BeforeToolCallEvent` callback so that the two checks are applied in a
well-defined order for every tool call:

1. Operation scope enforcement: reject the tool call outright when the
   current session's operation scope does not permit it, using the existing
   `scope.enforcement` module unchanged (Requirement 1.8 -- scope enforcement
   is independent of aws_profile).
2. aws_profile injection: when the tool's own schema declares an
   `aws_profile` parameter (i.e. mcp-proxy-for-aws's ProfileOverrideMiddleware
   is active for this tool -- Multi_Profile_Mode, Requirement 1.4), force the
   tool_use input's `aws_profile` value to the current request's
   `aws_profile_name`, or reject the call if the session has none
   (Requirement 2.5). When the schema does NOT declare `aws_profile`
   (Multi_Profile_Mode disabled for this tool, Requirement 1.5), neither
   injection nor rejection happens -- the tool call is left untouched.

Cross-request isolation (Requirement 2.6):
    `current_session_context` is a `contextvars.ContextVar` set by the
    FastAPI `/invocations` handler (main.py, task 7.1) immediately after
    extracting the request's `SessionContext`, and reset in a `finally`
    block once the request completes. Because asyncio tasks copy the current
    `contextvars.Context` when they are created, concurrently executing
    requests (different threads/sessions, or parallel tool calls within the
    same session) each observe only their own request's value here -- this
    hook never reads or caches a value belonging to another request.

No automatic retry (Requirement 1.6):
    This module intentionally does NOT define an `AfterToolCallEvent`
    callback. If `aws_profile` cannot be resolved by the Runtime execution
    environment, `mcp-proxy-for-aws`'s own `ProfileOverrideMiddleware` reports
    a `ToolError` for that single attempt; Strands' default behavior (execute
    once, surface the error) is left untouched. Adding retry logic here would
    violate Requirement 1.6.
"""

from __future__ import annotations

import contextvars
import logging

from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

from context.session_context import SessionContext
from scope.enforcement import build_rejection_message, is_allowed

logger = logging.getLogger(__name__)

current_session_context: contextvars.ContextVar[SessionContext | None] = contextvars.ContextVar(
    "current_session_context", default=None
)
"""Request-scoped SessionContext, set by the FastAPI /invocations handler.

Defaults to None so that this hook degrades safely (falls back to the most
restrictive "readonly" scope and treats aws_profile_name as absent) if it is
ever invoked outside of a request that set this context var -- e.g. during
local tool-discovery calls at startup.
"""

AUTH_REQUIRING_TOOLS = frozenset(
    {"call_aws", "run_script", "get_presigned_url", "get_tasks", "suggest_aws_commands"}
)
"""Tool names whose underlying operation requires AWS credentials and whose
schema mcp-proxy-for-aws's ProfileOverrideMiddleware may augment with an
`aws_profile` parameter when Multi_Profile_Mode is enabled (Requirement 1.4).
"""


class SessionScopeAndProfileHook(HookProvider):
    """Single shared BeforeToolCallEvent hook for scope enforcement + aws_profile injection.

    Registered once per template Agent (main.py) and shared across every
    session's tool calls (see design.md Component 3 / F5). Implementation
    mistakes here affect every concurrent session, so both responsibilities
    are kept intentionally small and delegate their core logic to existing,
    independently-tested pure functions (`scope.enforcement.is_allowed`).
    """

    def register_hooks(self, registry: HookRegistry) -> None:
        """Subscribe `_on_before_tool_call` to BeforeToolCallEvent.

        Args:
            registry: The HookRegistry provided by the Strands Agent this
                hook is attached to.
        """
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        """Enforce operation scope, then inject or reject aws_profile.

        Args:
            event: The BeforeToolCallEvent for the tool call about to run.
        """
        ctx = current_session_context.get()
        scope = ctx.operation_scope if ctx is not None else "readonly"
        tool_name = event.tool_use["name"]

        if not is_allowed(tool_name, scope):
            event.cancel_tool = build_rejection_message(tool_name, scope)
            return

        if not self._tool_accepts_aws_profile(event):
            # Multi_Profile_Mode disabled for this tool (Requirement 1.5):
            # no aws_profile parameter in the schema, so neither inject nor
            # reject -- leave the tool call arguments unmodified.
            return

        if ctx is None or not ctx.aws_profile_name:
            self._reject_missing_profile(event, tool_name)
            return

        tool_input = event.tool_use["input"]
        if isinstance(tool_input, dict):
            tool_input["aws_profile"] = ctx.aws_profile_name
        else:
            # Defensive fallback: ToolUse.input is documented as "any
            # JSON-serializable type", but every AUTH_REQUIRING_TOOLS schema
            # declares an object input. If a non-dict input is ever
            # encountered, fail safe by rejecting rather than silently
            # dropping the profile (which would let the call proceed without
            # the required aws_profile, violating Requirement 2.4).
            self._reject_missing_profile(event, tool_name)

    def _reject_missing_profile(self, event: BeforeToolCallEvent, tool_name: str) -> None:
        """Cancel the tool call because the session has no usable aws_profile_name.

        Sets `event.cancel_tool` first so the tool result is never reported
        as successful, then makes a best-effort attempt to log the rejection.
        A failure in the logging step itself is swallowed -- Requirement 1.7
        only guarantees the cancellation takes effect, not that reporting
        about it succeeds.

        Args:
            event: The BeforeToolCallEvent to cancel.
            tool_name: The name of the tool being rejected (for the message
                and log record).
        """
        event.cancel_tool = (
            f"Tool '{tool_name}' requires an AWS profile, but this session has no AWS "
            "profile configured. Please start a new session with a Connection that has "
            "a valid AWS profile."
        )
        try:
            logger.warning(
                "profile_injection.missing_profile",
                extra={"tool_name": tool_name},
            )
        except Exception:  # noqa: BLE001 - best-effort logging only (Requirement 1.7)
            pass

    @staticmethod
    def _tool_accepts_aws_profile(event: BeforeToolCallEvent) -> bool:
        """Check whether the tool being called declares an aws_profile parameter.

        Args:
            event: The BeforeToolCallEvent whose selected_tool schema is inspected.

        Returns:
            True only if the tool name is one of AUTH_REQUIRING_TOOLS AND its
            resolved tool schema's inputSchema.json.properties includes
            "aws_profile" (i.e. mcp-proxy-for-aws's ProfileOverrideMiddleware
            added it for this call, meaning Multi_Profile_Mode is enabled).
        """
        if event.tool_use["name"] not in AUTH_REQUIRING_TOOLS:
            return False

        tool = event.selected_tool
        if tool is None:
            return False

        schema = getattr(tool, "tool_spec", None) or {}
        properties = schema.get("inputSchema", {}).get("json", {}).get("properties", {})
        return "aws_profile" in properties
