"""Gateway / MCP_Proxy client module.

Creates a Strands MCPClient configured to connect to the AWS MCP Server.

The Agent does not connect directly to AWS MCP with SigV4. Instead it
launches `mcp-proxy-for-aws` as a stdio subprocess (build_aws_mcp_proxy_client)
which uses the AWS credentials present in the subprocess's environment
(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN) for SigV4
signing.

IMPORTANT (credential-injection timing bug and its fix): a subprocess's
environment is captured once, at the moment it is spawned, by the OS. A
prior revision of this module launched the subprocess with no `env=` at
all and relied on `roles/hook.py` mutating `os.environ` *after* the
subprocess had already started -- those mutations never reached the
already-running child process, so every tool call that actually needed AWS
credentials failed silently (the credentials the child process saw were
whatever was present in the container's environment at boot, not the
per-role assumed-role credentials). The fix is: obtain credentials via
`boto3 sts:AssumeRole` *before* the subprocess is (re)started, and pass them
explicitly via `build_aws_mcp_proxy_client(..., env=...)` /
`StdioServerParameters(env=...)` at construction time. Per-role credential
lifecycle (deciding *when* to call AssumeRole and *when* to restart the
subprocess with fresh credentials) is owned by `gateway/manager.py`
(McpClientManager), not by this module -- this module only knows how to
build a client/transport given an already-resolved `env` dict.

`build_gateway_client()` (direct AgentCore Gateway streamable-HTTP connection)
is retained but unused by this revision -- see its docstring for the scope
note on its repurposing.

Connection is deferred — no network activity occurs at module import or at
client construction time. The actual connection happens when the client is
used (entered as a context manager or tools are listed).

On connection failure, logs at error level and raises McpProxyConnectionError
so the caller can report an unreachable AWS MCP Server / MCP_Proxy to the user.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING

from mcp import StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp import MCPClient

if TYPE_CHECKING:
    from strands.tools.mcp import MCPTransport
    from strands.types.tools import AgentTool

logger = logging.getLogger(__name__)


class McpProxyConnectionError(Exception):
    """Raised when the MCP_Proxy (mcp-proxy-for-aws) client cannot establish a connection."""

    def __init__(self, endpoint: str, cause: Exception) -> None:
        self.endpoint = endpoint
        self.cause = cause
        super().__init__(
            f"Failed to connect to AWS MCP Server via mcp-proxy-for-aws at '{endpoint}': {cause}"
        )


def build_gateway_client(gateway_url: str, auth_token: str = "") -> MCPClient:
    """Build an MCPClient configured for the AgentCore Gateway.

    NOTE (multi-account-mcp-access revision): this function is NOT used by the
    current design. The Agent no longer connects through the Gateway concept
    at all -- it connects to a single AWS MCP Server endpoint via the
    mcp-proxy-for-aws stdio subprocess instead (see build_aws_mcp_proxy_client
    below). This function is kept only because renaming/removing the
    `gateway/` directory itself is out of scope for this revision; the
    directory's *purpose* has effectively been repurposed to "MCP_Proxy
    connection module" even though this particular direct-Gateway-connection
    function is dormant.

    Creates a Strands MCPClient with streamable HTTP transport. The client
    does NOT connect at construction time — connection is deferred until
    the client is entered as a context manager or tools are listed.

    When auth_token is empty (e.g. Gateway has authorizerType=NONE), no
    Authorization header is sent. This avoids sending an empty
    ``Authorization: Bearer `` header which causes connection failures.

    Args:
        gateway_url: The URL of the AgentCore Gateway MCP endpoint.
        auth_token: Bearer token for authenticating with the Gateway.
            If empty, no Authorization header is included.

    Returns:
        An MCPClient instance ready to be used as a context manager.
    """
    headers: dict[str, str] | None = None
    if auth_token:
        headers = {"Authorization": f"Bearer {auth_token}"}

    return MCPClient(
        lambda: streamablehttp_client(
            gateway_url,
            headers=headers,
        ),
        startup_timeout=30,
    )


def build_aws_mcp_proxy_transport_callable(
    endpoint: str = "https://aws-mcp.us-east-1.api.aws/mcp",
    region: str = "us-east-1",
    env: dict[str, str] | None = None,
) -> Callable[[], "MCPTransport"]:
    """Build the `transport_callable` used by an mcp-proxy-for-aws-backed MCPClient.

    Extracted from `build_aws_mcp_proxy_client` so that `gateway/manager.py`
    (McpClientManager) can reassign `MCPClient._transport_callable` on an
    *existing* MCPClient instance with a fresh `env` closure whenever the
    session's assumed-role credentials change, without constructing a brand
    new MCPClient object. Reusing the same MCPClient instance (rather than
    swapping which client the Agent's tool registry points at) is required
    because `ag_ui_strands.StrandsAgent` snapshots the template Agent's tool
    list once at construction time -- the `MCPAgentTool` entries in that
    snapshot hold a reference to a specific MCPClient object, so only
    mutating that object's own internal state (then calling `.stop()` /
    `.start()` again, which resets and reuses it) is guaranteed to be picked
    up by tool calls made through the already-snapshotted tools.

    Args:
        endpoint: The AWS MCP Server endpoint URL.
        region: AWS region for SigV4 signing performed by the proxy.
        env: Optional explicit environment variables (e.g. AWS credentials)
            to pass to the subprocess at spawn time. See
            `build_aws_mcp_proxy_client` for the merge semantics with
            `get_default_environment()`.

    Returns:
        A zero-argument callable that returns a new stdio transport each
        time it is invoked (i.e. each time the MCPClient (re)starts).
    """
    return lambda: stdio_client(
        StdioServerParameters(
            command="mcp-proxy-for-aws",
            args=[endpoint, "--service", "aws-mcp", "--region", region],
            env=env,
        )
    )


def build_aws_mcp_proxy_client(
    endpoint: str = "https://aws-mcp.us-east-1.api.aws/mcp",
    region: str = "us-east-1",
    env: dict[str, str] | None = None,
) -> MCPClient:
    """Build an MCPClient backed by the mcp-proxy-for-aws stdio subprocess.

    Launches `mcp-proxy-for-aws` as a stdio MCP server subprocess instead of
    connecting directly to AWS MCP with SigV4. The subprocess signs its
    requests using whatever AWS credentials are present in its environment
    (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN).

    IMPORTANT: pass credentials via `env`, not by mutating `os.environ`
    after the fact. A subprocess's environment is a snapshot taken at spawn
    time by the OS -- mutating `os.environ` in the parent process after the
    subprocess has already started has no effect on that already-running
    child process. This is the fix for the bug where credentials injected
    into `os.environ` post-startup never reached `mcp-proxy-for-aws`.

    When `env` is provided, it is passed straight through as
    `StdioServerParameters(env=...)`. `mcp.client.stdio.stdio_client` merges
    it on top of `mcp.client.stdio.get_default_environment()` automatically
    (see its implementation), so callers only need to supply the credential
    keys they care about (e.g. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
    AWS_SESSION_TOKEN) -- there is no need to call
    `get_default_environment()` here.

    When `env` is omitted (`None`), behavior is unchanged from before this
    parameter was added: `StdioServerParameters` receives no `env=` at all,
    and the subprocess inherits `get_default_environment()` only.

    Args:
        endpoint: The AWS MCP Server endpoint URL.
        region: AWS region for SigV4 signing performed by the proxy.
        env: Optional explicit environment variables (e.g. AWS credentials)
            to pass to the subprocess at spawn time, merged on top of
            `get_default_environment()` by `stdio_client`. Callers that need
            the subprocess to use specific AWS credentials (e.g. from a
            `sts:AssumeRole` call) MUST supply them here at construction
            time -- setting `os.environ` after the client/subprocess has
            already started will NOT reach the subprocess.

    Returns:
        An MCPClient instance backed by the mcp-proxy-for-aws stdio subprocess.
    """
    return MCPClient(
        build_aws_mcp_proxy_transport_callable(endpoint=endpoint, region=region, env=env),
        startup_timeout=60,
    )


def discover_tools(client: MCPClient) -> list[AgentTool]:
    """Discover all available tools from the AWS MCP Server via the MCPClient.

    The client must already be started (entered as a context manager) before
    calling this function.

    Args:
        client: A started MCPClient instance.

    Returns:
        A list of AgentTool objects representing the tools available
        across all Gateway targets.

    Raises:
        McpProxyConnectionError: If tool discovery fails due to a connection issue.
    """
    try:
        tools = client.list_tools_sync()
        logger.info(
            "gateway.tools_discovered",
            extra={"tool_count": len(tools)},
        )
        return list(tools)
    except Exception as exc:
        logger.error(
            "gateway.tool_discovery_failed",
            extra={
                "exception_type": type(exc).__name__,
                "exception_message": str(exc),
            },
        )
        raise McpProxyConnectionError(
            endpoint="(active session)",
            cause=exc,
        ) from exc
