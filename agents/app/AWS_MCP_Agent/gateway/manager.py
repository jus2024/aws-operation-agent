"""Lazy, rebuild-on-role-change lifecycle manager for the shared MCP_Proxy client.

Owns the single `MCPClient` instance that backs the template Agent's tool
registry (see main.py) and decides *when* the underlying `mcp-proxy-for-aws`
stdio subprocess needs to be (re)started with fresh, per-role AWS
credentials.

Why this module exists (the credential-injection timing bug and its fix):
a subprocess's environment is captured once, at the moment it is spawned,
by the OS. `gateway/client.py` now accepts an explicit `env=` dict at
construction time so the subprocess launches with the right AWS credentials
already in its environment -- but there are two problems this module solves
that `gateway/client.py` alone cannot:

1. `main.py` builds the template Strands `Agent` (and therefore the shared
   `MCPClient`, via `tools=[mcp_client]`) at Python **module import time**,
   before any HTTP request has arrived. At that point no session Role_Set is
   known yet -- it only becomes available once a request's `X-Role-Names`
   header is parsed (see `context/session_context.py`) and, for a
   credential-requiring tool call, a `role_name` is resolved from that
   Role_Set (see `roles/hook.py`). So the *first* subprocess start (used
   purely for tool-schema discovery via
   `MCPClient.load_tools()` / `list_tools_sync()`) necessarily happens with
   no explicit per-role credentials; it relies on whatever ambient AWS
   identity the Runtime container's default boto credential chain resolves
   to. That is fine for *listing* tool schemas, but tool *invocation*
   (`call_aws`, `run_script`, etc.) must use the credentials of the role the
   current session selected.

2. `ag_ui_strands.StrandsAgent` snapshots the template Agent's tool list
   **once**, at `StrandsAgent.__init__` time (`self._tools = list(agent.
   tool_registry.registry.values())`). The `MCPAgentTool` entries in that
   snapshot hold a reference to a *specific* `MCPClient` Python object.
   Swapping which `MCPClient` the Agent points at after construction has no
   effect -- `StrandsAgent` already copied the tools list and will keep
   calling back into the original `MCPClient` instance for the lifetime of
   the process. Therefore credentials cannot be rotated by constructing a
   *new* `MCPClient`; the *same* instance must be reused.

The chosen primitive (documented here since it is the crux of the design):
`strands.tools.mcp.MCPClient.stop()` explicitly resets all internal state
"to allow instance reuse" (see the SDK's own comment to that effect), and
`start()` can safely be called again afterwards. So this manager, on a role
change, calls `client.stop()`, reassigns the client's private
`_transport_callable` attribute to a fresh closure that captures the new
role's credentials as `env`, then calls `client.start()` again -- all on the
*same* `MCPClient` object. Because `MCPAgentTool` instances only ever hold a
reference to the `MCPClient` object (not to its `_transport_callable`), this
keeps the already-snapshotted tools in `StrandsAgent._tools` working
correctly after every rebuild. Reassigning a "private" attribute directly is
an unusual integration seam, but it is the only supported reuse path the SDK
exposes for this scenario; there is no public API to swap the transport of a
running client without accessing this attribute.

Concurrency: `ensure_role()` guards the check-and-maybe-rebuild sequence
with an `asyncio.Lock` so two concurrent tool calls in flight (e.g. two
tool calls within the same session's single turn, or -- defensively --
requests for different sessions that happen to land on the same microVM,
see the module docstring in `roles/hook.py`) never race to stop/reassign/
start the shared subprocess simultaneously. `MCPClient.stop()`/`start()` are
themselves synchronous, blocking calls (they manage their own background
thread and block the caller with `Future.result(timeout=...)`), so they are
run via `asyncio.to_thread()` to avoid blocking the event loop while the
lock is held.

In-flight call tracking (the "stop() steals a running connection" bug and
its fix): the original design above only serialized the *rebuild* sequence
itself. It did not account for a tool call that has already passed
`ensure_role()` and is now executing `call_tool_async()` against the
subprocess -- that call is *not* holding `_lock` while it awaits the MCP
server's response. If a *different* role's tool call arrives concurrently
(the common case when an LLM issues one `tool_use` per role in the same
turn, e.g. "check the cost in all 4 configured accounts"), its
`ensure_role()` sees a role change, acquires `_lock`, and calls
`client.stop()` -- which tears down the *same* subprocess the first call's
`call_tool_async()` is still awaiting a response from, surfacing as
`RuntimeError("Connection to the MCP server was closed")` for the first
call. Because the shared subprocess can only ever run as one role at a
time, this manager now tracks the number of *in-flight* calls for the
currently-active role (`_in_flight_count`) and, when a role change is
needed, `ensure_role()` awaits `self._idle.wait_for(...)` (releasing
`_lock` while waiting) until that count reaches zero before tearing down
the subprocess. This
intentionally serializes tool calls across a role change -- concurrent
calls to the *same* role are unaffected and still run in parallel against
the subprocess (Requirement: cheap reuse / no serialization penalty for
the common single-role-per-session case).

Caching behavior: once a role's subprocess is running, subsequent tool
calls for the *same* role_name are a cheap no-op (no new AssumeRole call, no
subprocess restart) -- this is what keeps normal operation (one role per
session, the common case) cheap. Only a role_name *change* on an existing,
already-running client triggers a teardown + fresh AssumeRole + restart.
This guards against the microVM-reuse edge case: because
`src/app/api/copilotkit/route.ts` does not yet send the AgentCore
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header, a given microVM is not
guaranteed to serve only one logical session/role for its whole lifetime.
"""

from __future__ import annotations

import asyncio
import logging

from strands.tools.mcp import MCPClient

from gateway.client import (
    build_aws_mcp_proxy_client,
    build_aws_mcp_proxy_transport_callable,
)
from roles.sts import assume_role

logger = logging.getLogger(__name__)


class McpClientManager:
    """Owns the single shared MCPClient instance and its credential lifecycle.

    One instance of this class is created at `main.py` module import time
    and shared by every session's `BeforeToolCallEvent` hook invocation
    (see `roles/hook.py`).
    """

    def __init__(self, endpoint: str, region: str) -> None:
        """Initialize the manager.

        Args:
            endpoint: The AWS MCP Server endpoint URL, forwarded to
                `build_aws_mcp_proxy_client` / `build_aws_mcp_proxy_transport_callable`
                on every (re)build.
            region: AWS region for SigV4 signing performed by the proxy,
                forwarded on every (re)build.
        """
        self._endpoint = endpoint
        self._region = region
        self._client: MCPClient | None = None
        self._active_role_name: str | None = None
        """The Role_Name the shared subprocess is currently running as, or
        None if it has only ever been started with no explicit per-role
        credentials (the initial tool-discovery start at import time)."""
        self._lock = asyncio.Lock()
        self._in_flight_count = 0
        """Number of tool calls currently executing against `_active_role_name`'s
        subprocess (between `ensure_role()` returning and the matching
        `release()` call once that tool call finishes). A role change must
        wait for this to reach zero before tearing down the subprocess --
        see the `self._idle.wait_for(...)` call in `ensure_role()`."""
        self._idle = asyncio.Condition(self._lock)
        """Signaled by `release()` whenever `_in_flight_count` reaches zero,
        so `ensure_role()`'s `self._idle.wait_for(...)` can wake up without
        polling."""

    def build_initial_client(self) -> MCPClient:
        """Build (but do not start) the shared MCPClient with no explicit credentials.

        Called once at `main.py` import time so the template Strands
        `Agent`'s `tools=[...]` wiring has a stable `MCPClient` object to
        reference. `strands.tools.registry.ToolRegistry.process_tools()`
        will call `MCPClient.load_tools()` synchronously as part of
        `Agent(tools=[mcp_client])` construction, which lazily calls
        `.start()` on first use (per the `ToolProvider` interface) purely to
        discover tool schemas -- this succeeds using whatever ambient AWS
        identity the Runtime container's default credential chain resolves
        to, which is sufficient for listing tools but not for per-role tool
        invocation. `ensure_role()` is what later restarts this same
        instance with real per-role credentials before a credentialed tool
        call is allowed to proceed.

        Returns:
            The newly constructed (not yet started) MCPClient instance.
        """
        self._client = build_aws_mcp_proxy_client(endpoint=self._endpoint, region=self._region)
        return self._client

    @property
    def client(self) -> MCPClient:
        """The shared MCPClient instance.

        Raises:
            RuntimeError: If accessed before `build_initial_client()` has
                been called.
        """
        if self._client is None:
            raise RuntimeError(
                "McpClientManager.client accessed before build_initial_client() was called"
            )
        return self._client

    async def ensure_role(self, role_name: str, role_arn: str) -> None:
        """Ensure the shared MCPClient's subprocess is running with credentials for role_name.

        If the subprocess is already running with credentials for this
        exact role_name, this is a cheap no-op (Requirement: reuse across
        calls within the same role). Otherwise, calls `boto3 sts:AssumeRole`
        for `role_arn`, then stops and restarts the *same* `MCPClient`
        instance with a fresh `_transport_callable` closure carrying the new
        credentials as `env` (see module docstring for why the same
        instance must be reused rather than constructing a new one).

        Args:
            role_name: The Role_Name to ensure is active. Compared against
                the cached active role to decide whether a rebuild is
                needed.
            role_arn: The IAM Role_ARN to assume when a rebuild is needed.

        Raises:
            Exception: Whatever `boto3 sts:AssumeRole` raises on failure
                (e.g. ClientError, BotoCoreError), or whatever `MCPClient.
                start()` raises if the subprocess fails to (re)start. In
                either case the previous state is left as-is except that a
                failed `start()` after a successful `stop()` leaves the
                shared client stopped -- callers (roles/hook.py) surface
                this as a tool-call cancellation with a descriptive error;
                a subsequent call will retry the full sequence.
        """
        async with self._lock:
            if self._active_role_name == role_name:
                # Cheap reuse path: register this call as in-flight before
                # releasing the lock so a concurrent role change (from a
                # different tool call) correctly waits for it to finish
                # (see the `self._idle.wait_for(...)` call below).
                self._in_flight_count += 1
                return

            # A role change is needed. Wait for every in-flight call against
            # the *currently active* role to finish before tearing down the
            # subprocess -- otherwise `client.stop()` below would sever the
            # connection out from under a `call_tool_async()` that is still
            # awaiting a response (the bug this tracking exists to prevent;
            # see module docstring "In-flight call tracking").
            await self._idle.wait_for(lambda: self._in_flight_count == 0)

            # Re-check after waking: another coroutine may have already
            # rebuilt for this exact role while we were waiting.
            if self._active_role_name == role_name:
                self._in_flight_count += 1
                return

            logger.info("gateway.manager.assuming_role", extra={"role_name": role_name})
            credentials = await asyncio.to_thread(assume_role, role_arn, role_name)

            env = {
                "AWS_ACCESS_KEY_ID": credentials["AccessKeyId"],
                "AWS_SECRET_ACCESS_KEY": credentials["SecretAccessKey"],
                "AWS_SESSION_TOKEN": credentials["SessionToken"],
            }

            client = self.client

            logger.info(
                "gateway.manager.rebuilding_subprocess",
                extra={"previous_role_name": self._active_role_name, "new_role_name": role_name},
            )
            await asyncio.to_thread(client.stop, None, None, None)

            # NOTE: `_transport_callable` is a "private" MCPClient attribute.
            # Reassigning it directly on the existing instance (rather than
            # constructing a new MCPClient) is intentional -- see the module
            # docstring for why the same object identity must be preserved.
            client._transport_callable = build_aws_mcp_proxy_transport_callable(
                endpoint=self._endpoint,
                region=self._region,
                env=env,
            )
            await asyncio.to_thread(client.start)

            self._active_role_name = role_name
            self._in_flight_count += 1
            logger.info("gateway.manager.rebuilt", extra={"role_name": role_name})

    async def release(self, role_name: str) -> None:
        """Mark one in-flight tool call against `role_name` as finished.

        Must be called exactly once for every successful `ensure_role()`
        call, after the corresponding tool call has actually completed
        (whether it succeeded or raised) -- see `roles/hook.py`'s
        `AfterToolCallEvent` callback, which pairs with `BeforeToolCallEvent`
        for exactly this purpose.

        If `role_name` no longer matches the currently-active role (a role
        change already happened concurrently, which cannot occur under
        correct pairing but is tolerated defensively), this is a no-op:
        decrementing a stale role's counter would incorrectly unblock a
        rebuild that is waiting on the *new* role's in-flight count instead.

        Args:
            role_name: The Role_Name that was passed to the paired
                `ensure_role()` call.
        """
        async with self._lock:
            if self._active_role_name != role_name:
                return
            self._in_flight_count -= 1
            if self._in_flight_count == 0:
                self._idle.notify_all()
