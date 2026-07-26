"""Dynamic tool-schema augmentation for role_name selection.

Strands re-reads every registered `AgentTool`'s `tool_spec` property fresh on
every event-loop turn (`ToolRegistry.get_all_tool_specs()`, called from
`strands/event_loop/event_loop.py` at both the initial and every subsequent
turn). This lets `tool_spec` be computed dynamically from
`current_session_context` without needing per-request tool objects or a
Strands SDK patch.

`RoleSelectingToolWrapper` wraps each of the four AWS-credential-requiring
tools (`call_aws`, `run_script`, `get_presigned_url`, `get_tasks`) so that,
when the current session's Role_Set (`SessionContext.role_names`, see
`context/session_context.py`) has two or more entries, the tool's schema
gains a required `role_name` parameter restricted to that Role_Set
(Requirement 4.1). When the Role_Set has exactly one entry (or is empty),
no such parameter is exposed (Requirement 4.2) -- `roles/hook.py`'s
`BeforeToolCallEvent` hook resolves the sole entry automatically in that
case, and rejects the call outright when the Role_Set is empty.

See design.md Component 15 for the design rationale.
"""

from __future__ import annotations

from strands.types.tools import AgentTool, ToolGenerator, ToolSpec, ToolUse

from roles.hook import current_session_context

ROLE_NAME_PARAM = "role_name"
"""The name of the dynamically-injected role selection parameter."""


class RoleSelectingToolWrapper(AgentTool):
    """Wraps a credential-requiring AgentTool to expose a dynamic role_name parameter.

    When the current SessionContext's Role_Set has 2+ entries, `tool_spec`
    includes a required `role_name` string parameter whose enum is exactly
    the current Role_Set's Role_Names (Requirement 4.1). When the Role_Set
    has exactly 1 entry (or is empty), no such parameter is exposed
    (Requirement 4.2) -- the wrapped hook (`roles/hook.py`) resolves the
    sole entry automatically in that case.

    `stream()` delegates unmodified to the wrapped tool: by the time a
    tool's `stream()` runs, `BeforeToolCallEvent` has already fired and
    `roles/hook.py` has already popped `role_name` from
    `tool_use["input"]`, so the wrapped tool never sees the
    pseudo-parameter.

    Args:
        wrapped: The underlying `AgentTool` (e.g. the `call_aws` tool as
            registered by the AgentCore Gateway or a local MCP connection)
            whose schema this wrapper augments.
    """

    def __init__(self, wrapped: AgentTool) -> None:
        super().__init__()
        self._wrapped = wrapped

    @property
    def tool_name(self) -> str:
        """The wrapped tool's name, unchanged."""
        return self._wrapped.tool_name

    @property
    def tool_type(self) -> str:
        """The wrapped tool's type, unchanged."""
        return self._wrapped.tool_type

    @property
    def tool_spec(self) -> ToolSpec:
        """The wrapped tool's spec, with `role_name` injected when Role_Set has 2+ entries.

        Recomputed on every access (Strands calls this fresh every
        event-loop turn), so it always reflects the current request's
        `SessionContext` rather than a value captured at construction time.

        Returns:
            The wrapped tool's `tool_spec` unmodified if the current
            Role_Set has fewer than 2 entries (Requirement 4.2); otherwise
            a copy with a required `role_name` string parameter added to
            `inputSchema.json.properties`/`required`, whose `enum` is
            exactly the current Role_Set's Role_Names (Requirement 4.1).
        """
        spec = dict(self._wrapped.tool_spec)
        ctx = current_session_context.get()
        role_names = ctx.role_names if ctx is not None else ()

        if len(role_names) < 2:
            return spec  # Requirement 4.2 -- no parameter exposed

        schema = dict(spec["inputSchema"]["json"])
        properties = dict(schema.get("properties", {}))
        properties[ROLE_NAME_PARAM] = {
            "type": "string",
            "enum": list(role_names),
            "description": (
                "Which configured AWS role/account to use for this specific "
                "tool call. Choose based on which account or permission "
                "level the requested operation targets."
            ),
        }
        schema["properties"] = properties
        schema["required"] = list({*schema.get("required", []), ROLE_NAME_PARAM})
        spec["inputSchema"] = {"json": schema}
        return spec

    async def stream(
        self, tool_use: ToolUse, invocation_state: dict, **kwargs: object
    ) -> ToolGenerator:
        """Delegate tool execution unmodified to the wrapped tool.

        By the time this runs, `BeforeToolCallEvent` (`roles/hook.py`) has
        already popped `role_name` out of `tool_use["input"]` (if it was
        present), so the wrapped tool never sees the pseudo-parameter this
        wrapper injects into the schema.

        Args:
            tool_use: The tool use request, with `role_name` already
                removed from its input by `roles/hook.py` if applicable.
            invocation_state: Caller-provided kwargs passed through
                unmodified.
            **kwargs: Additional keyword arguments passed through
                unmodified.

        Yields:
            Whatever the wrapped tool's `stream()` yields, unmodified.
        """
        async for event in self._wrapped.stream(tool_use, invocation_state, **kwargs):
            yield event
