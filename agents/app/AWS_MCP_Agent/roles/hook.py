"""BeforeToolCallEvent hook: per-tool-call Role_Entry selection + lazy credentialed-subprocess rebuild.

This module replaces the deprecated `profile/injection.py` (Multi_Profile_Mode
`aws_profile` parameter injection, which does not work in the AgentCore
Runtime MicroVM/MMDS environment -- see design.md "New architecture
overview"). It implements the single shared Strands hook that is registered
once on the template Agent (see main.py) and therefore runs for every tool
call in every session.

Unlike the earlier session-wide design (a single `role_name`/`operation_scope`
decided once per session), this hook now performs Role_Entry *selection* on
every qualifying tool call, independently, from the session's Role_Set
(`SessionContext.role_names`, Requirement 4). Each qualifying tool call goes
through the following responsibilities, in a well-defined order:

1. Role_Entry selection: resolve which Role_Entry this specific tool call
   should use out of the session's Role_Set -- auto-selecting the sole entry
   when the Role_Set has exactly one, or reading an LLM-supplied `role_name`
   tool-input parameter (popped before the call reaches the downstream tool)
   when it has two or more (Requirement 4, 6).
2. Operation scope enforcement: reject the tool call outright when the
   *selected Role_Entry's* scope does not permit it, using the existing
   `scope.enforcement` module unchanged, strictly before any STS AssumeRole
   call is made (Requirement 5.1, 5.2).
3. Ensuring the shared `mcp-proxy-for-aws` subprocess is running with the
   selected Role_Entry's credentials: delegate to
   `gateway.manager.McpClientManager.ensure_role()`, which calls
   `boto3 sts:AssumeRole` for that role's ARN and (re)starts the shared
   `MCPClient`'s subprocess with the resulting temporary credentials passed
   as `env=` at construction time -- never via a post-startup `os.environ`
   mutation (see `gateway/client.py` module docstring for why that pattern
   was broken: a subprocess's environment is captured once, at spawn time,
   by the OS, so mutating `os.environ` in the parent process after the
   subprocess has already started never reaches the already-running child).

Per-tool-call Role_Entry selection, with AssumeRole cached only while the
resolved role is unchanged (Requirement 7.4, 7.5 intent -- credentials are
never read from a stale cache across a role change):
    `McpClientManager.ensure_role()` only calls STS AssumeRole (and restarts
    the subprocess) when the resolved Role_Name differs from the one the
    subprocess is currently running as. The Role_Name used for each call is
    derived exclusively from the selection made for that specific tool call
    (from `current_session_context.get()`'s Role_Set) -- never reused,
    cached, or carried over from any other request's or any other tool
    call's selection. Because a single session's Role_Set may contain
    multiple Role_Entry candidates, and different tool calls within the
    same session may select different ones, this hook re-runs the full
    selection + scope + AssumeRole sequence independently for every
    qualifying tool call rather than assuming "first role wins for the rest
    of the session".

Cross-request isolation:
    `current_session_context` is a `contextvars.ContextVar` set by the
    FastAPI `/invocations` handler (main.py) immediately after extracting
    the request's `SessionContext`, and reset in a `finally` block once the
    request completes. Because asyncio tasks copy the current
    `contextvars.Context` when they are created, concurrently executing
    requests each observe only their own request's value here.

Concurrency of subprocess rebuilds:
    Unlike the previous `os.environ`-mutation approach (safe because a
    single MicroVM processes one request at a time), rebuilding the shared
    subprocess is itself a multi-step, awaitable operation (AssumeRole, then
    stop/start). `McpClientManager.ensure_role()` guards this sequence with
    its own `asyncio.Lock` so two concurrent tool calls never race to
    rebuild the subprocess simultaneously; this hook does not need its own
    additional locking.
"""

from __future__ import annotations

import contextvars
import logging

from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

from context.session_context import SessionContext
from gateway.manager import McpClientManager
from roles.config import get_role_by_name
from scope.enforcement import build_rejection_message, is_allowed

logger = logging.getLogger(__name__)

current_session_context: contextvars.ContextVar[SessionContext | None] = contextvars.ContextVar(
    "current_session_context", default=None
)
"""Request-scoped SessionContext, set by the FastAPI /invocations handler.

Moved here from the deprecated `profile/injection.py` (Requirement 9.2, 9.3).
Defaults to None so that this hook degrades safely (treats the Role_Set as
empty, which rejects every AWS-credential-requiring tool call via
`_reject_empty_role_set`) if it is ever invoked outside of a request that
set this context var -- e.g. during local tool-discovery calls at startup.
"""

AWS_CREDENTIAL_TOOLS = frozenset({"call_aws", "run_script", "get_presigned_url", "get_tasks"})
"""Tool names whose underlying operation requires AWS credentials to be
present in the process environment for the `mcp-proxy-for-aws` subprocess to
sign requests with (Requirement 2.1).

Unlike the deprecated `profile/injection.py` AUTH_REQUIRING_TOOLS set, this
set intentionally excludes `suggest_aws_commands` -- that tool was specific
to Multi_Profile_Mode schema inspection and is no longer relevant under the
direct STS AssumeRole approach.

These are the *bare* tool names as defined by `mcp-proxy-for-aws` itself.
When a tool call arrives through the AgentCore Gateway (as opposed to a
direct local MCP connection), the Gateway prefixes the tool name with its
target name, e.g. `aws___call_aws` for the `call_aws` tool exposed by the
`aws` Gateway target (confirmed via CloudWatch logs recording
`Tool #1: aws___call_aws`). Membership checks against this set must
therefore compare the *normalized* tool name (see `_strip_gateway_prefix`
below), not the raw `event.tool_use["name"]` value, or every credential
check silently no-ops and `McpClientManager.ensure_role()` is never called.
"""


def _strip_gateway_prefix(tool_name: str) -> str:
    """Strip an AgentCore Gateway target-name prefix from a tool name.

    AgentCore Gateway namespaces every tool it exposes as
    `{target_name}___{tool_name}` (triple underscore separator), e.g.
    `aws___call_aws` for the `call_aws` tool on the `aws` Gateway target.
    Bare/local MCP connections (e.g. local dev via `agentcore dev` without a
    Gateway in front) do not add this prefix, so `event.tool_use["name"]`
    may or may not carry it depending on how the agent is invoked.

    This helper normalizes both cases to the bare tool name so that
    membership checks against `AWS_CREDENTIAL_TOOLS` (and any other
    tool-name comparison in this module) work regardless of whether the
    call arrived via the Gateway or directly. It intentionally only
    normalizes the name used for *comparisons* -- callers must keep using
    the original `event.tool_use["name"]` for logging and user-facing
    rejection messages so those messages reflect what the caller actually
    invoked.

    Uses `str.rpartition("___")` (rightmost split) so that a tool name
    which itself happens to contain `___` more than once still splits at
    the *last* occurrence, matching the Gateway's own
    `{target}___{tool}` convention (the target name is the prefix, the
    remainder -- however it's spelled -- is the tool name).

    Args:
        tool_name: The raw tool name from `event.tool_use["name"]`, which
            may or may not carry a Gateway target-name prefix.

    Returns:
        The tool name with any `{target}___` prefix removed. If `___` does
        not appear in `tool_name`, returns `tool_name` unchanged.
    """
    _prefix, separator, remainder = tool_name.rpartition("___")
    if not separator:
        return tool_name
    return remainder

class SessionScopeAndRoleHook(HookProvider):
    """Single shared BeforeToolCallEvent hook for per-tool-call Role_Entry selection + credentialed subprocess rebuild.

    Registered once per template Agent (main.py) and shared across every
    session's tool calls (see design.md Component 14). Implementation
    mistakes here affect every concurrent session, so each responsibility
    (Role_Entry selection, scope enforcement, subprocess rebuild) is kept
    intentionally small and delegates its core logic to existing,
    independently-tested pure functions (`scope.enforcement.is_allowed`) or
    well-scoped helpers below. The execution order -- select Role_Entry,
    enforce its scope, only then call STS -- must be preserved exactly: a
    scope rejection must never be bypassed by an AssumeRole call that has
    already happened.

    Args:
        mcp_client_manager: The shared `McpClientManager` (constructed once
            in main.py alongside the template Agent) that owns the actual
            `MCPClient`/subprocess lifecycle. This hook only decides
            *whether* a role check is needed and *which* role to ensure --
            the manager decides whether a rebuild is actually necessary
            (Requirement: cheap reuse when the role hasn't changed).
    """

    def __init__(self, mcp_client_manager: McpClientManager) -> None:
        self._mcp_client_manager = mcp_client_manager

    def register_hooks(self, registry: HookRegistry) -> None:
        """Subscribe `_on_before_tool_call` to BeforeToolCallEvent.

        Args:
            registry: The HookRegistry provided by the Strands Agent this
                hook is attached to.
        """
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    async def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        """Select a Role_Entry for this specific tool call, then ensure the subprocess runs as it.

        This callback is async (Strands invokes `BeforeToolCallEvent`
        callbacks via `HookRegistry.invoke_callbacks_async`, which supports
        both sync and async callbacks) because ensuring the subprocess is
        running with the right role's credentials may require an awaited
        STS AssumeRole call and an awaited subprocess restart --
        see `gateway.manager.McpClientManager.ensure_role`.

        Unlike the previous session-wide single `role_name`/`scope`
        decision, every qualifying tool call now independently selects a
        Role_Entry from the session's Role_Set (Requirement 4). Order of
        operations (Requirement 5.1, 5.2 -- scope enforcement strictly
        before any STS call):
            1. Skip tools that don't require AWS credentials, comparing the
               Gateway-prefix-normalized tool name (see
               `_strip_gateway_prefix`) against `AWS_CREDENTIAL_TOOLS`, since
               tool calls arriving through the AgentCore Gateway carry a
               `{target}___` prefix (e.g. `aws___call_aws`) that a bare
               `in AWS_CREDENTIAL_TOOLS` check would never match.
            2. Reject if the session's Role_Set is empty (Requirement 6.1).
            3. If the Role_Set has exactly one entry, select it
               automatically (Requirement 4.2) -- no `role_name` parameter
               is expected from the LLM in this case.
            4. Otherwise, pop the LLM-supplied `role_name` out of
               `event.tool_use["input"]` (it must never reach the
               downstream `mcp-proxy-for-aws` tool, which has no such
               parameter). Reject if absent (Requirement 6.3) or not a
               member of the current Role_Set (Requirement 4.7, 6.2).
            5. Resolve the RoleConfig for the selected role_name; reject if
               unknown.
            6. Enforce the selected Role_Entry's scope -- rejects disallowed
               tool calls before any STS AssumeRole call is ever made
               (Requirement 5.1, 5.2).
            7. Delegate to `McpClientManager.ensure_role()`, which calls STS
               AssumeRole (only if the role actually changed) and restarts
               the shared subprocess with the resulting credentials passed
               as `env=` at construction time; reject with a descriptive
               error on failure (Requirement 7.1, 7.2).

        Args:
            event: The BeforeToolCallEvent for the tool call about to run.
        """
        tool_name = event.tool_use["name"]

        # Compare the Gateway-prefix-normalized name here only -- `tool_name`
        # itself (used below in log records/rejection messages) must stay
        # as the caller originally invoked it.
        if _strip_gateway_prefix(tool_name) not in AWS_CREDENTIAL_TOOLS:
            # Tool does not require AWS credentials -- allow through
            # unmodified, no Role_Entry selection/STS call/subprocess
            # rebuild needed.
            return

        ctx = current_session_context.get()
        role_set = ctx.role_names if ctx is not None else ()

        if not role_set:
            self._reject_empty_role_set(event, tool_name)
            return

        if len(role_set) == 1:
            role_name = role_set[0]
        else:
            role_name = event.tool_use["input"].pop("role_name", None)
            if role_name is None:
                self._reject_missing_role_name_param(event, tool_name)
                return
            if role_name not in role_set:
                self._reject_invalid_role_name(event, tool_name, role_name)
                return

        role_config = get_role_by_name(role_name)
        if role_config is None:
            self._reject_unknown_role(event, tool_name, role_name)
            return

        # Scope enforcement is applied per selected Role_Entry, strictly
        # before any STS call is made (Requirement 5.1, 5.2).
        if not is_allowed(tool_name, role_config.scope):
            event.cancel_tool = build_rejection_message(tool_name, role_config.scope)
            return

        try:
            await self._mcp_client_manager.ensure_role(role_name, role_config.role_arn)
        except Exception as exc:  # noqa: BLE001 - any AssumeRole/rebuild failure must be surfaced (Requirement 7.1, 7.2)
            self._reject_assume_role_failure(event, role_name, exc)
            return

    def _reject_empty_role_set(self, event: BeforeToolCallEvent, tool_name: str) -> None:
        """Cancel the tool call because the session has no Role_Set configured.

        Args:
            event: The BeforeToolCallEvent to cancel.
            tool_name: The name of the tool being rejected (for the message
                and log record).
        """
        event.cancel_tool = (
            f"Tool '{tool_name}' requires AWS credentials, but this session has no role "
            "configured. Please start a new session with at least one role selected."
        )
        try:
            logger.warning("roles.hook.empty_role_set", extra={"tool_name": tool_name})
        except Exception:  # noqa: BLE001 - best-effort logging only
            pass

    def _reject_missing_role_name_param(
        self, event: BeforeToolCallEvent, tool_name: str
    ) -> None:
        """Cancel the tool call because the LLM did not supply a role_name parameter.

        Only reachable when the session's Role_Set has 2+ entries, in which
        case the LLM is required to disambiguate via a `role_name`
        parameter (Requirement 6.3).

        Args:
            event: The BeforeToolCallEvent to cancel.
            tool_name: The name of the tool being rejected.
        """
        event.cancel_tool = (
            f"Tool '{tool_name}' requires a 'role_name' parameter to select which "
            "configured AWS role/account to use, but none was provided."
        )
        try:
            logger.warning(
                "roles.hook.missing_role_name_param", extra={"tool_name": tool_name}
            )
        except Exception:  # noqa: BLE001 - best-effort logging only
            pass

    def _reject_invalid_role_name(
        self, event: BeforeToolCallEvent, tool_name: str, role_name: str
    ) -> None:
        """Cancel the tool call because role_name is not in the session's Role_Set.

        Args:
            event: The BeforeToolCallEvent to cancel.
            tool_name: The name of the tool being rejected.
            role_name: The LLM-supplied Role_Name that is not a member of
                the current session's Role_Set.
        """
        event.cancel_tool = (
            f"Role '{role_name}' is not part of the current session's selected roles."
        )
        try:
            logger.warning(
                "roles.hook.invalid_role_name",
                extra={"tool_name": tool_name, "role_name": role_name},
            )
        except Exception:  # noqa: BLE001 - best-effort logging only
            pass

    def _reject_unknown_role(
        self, event: BeforeToolCallEvent, tool_name: str, role_name: str
    ) -> None:
        """Cancel the tool call because role_name has no matching RoleConfig.

        Args:
            event: The BeforeToolCallEvent to cancel.
            tool_name: The name of the tool being rejected.
            role_name: The unresolved Role_Name.
        """
        event.cancel_tool = f"Role '{role_name}' is not found in the current configuration."
        try:
            logger.warning(
                "roles.hook.unknown_role",
                extra={"tool_name": tool_name, "role_name": role_name},
            )
        except Exception:  # noqa: BLE001 - best-effort logging only
            pass

    def _reject_assume_role_failure(
        self, event: BeforeToolCallEvent, role_name: str, exc: Exception
    ) -> None:
        """Cancel the tool call with a descriptive STS AssumeRole failure message.

        The message includes both the role name and a description of the
        failure (Requirement 7.1, 7.2).

        Args:
            event: The BeforeToolCallEvent to cancel.
            role_name: The Role_Name whose AssumeRole call failed.
            exc: The exception raised by the STS AssumeRole call.
        """
        event.cancel_tool = f"Failed to assume role '{role_name}': {exc}"
        try:
            logger.error(
                "roles.hook.assume_role_failed",
                extra={"role_name": role_name, "error": str(exc)},
            )
        except Exception:  # noqa: BLE001 - best-effort logging only
            pass
