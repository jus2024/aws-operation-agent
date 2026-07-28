"""AG-UI application entry point for AWS MCP Agent.

Connects to the AWS MCP Server through a single mcp-proxy-for-aws stdio
subprocess, shared (via the template Agent's tool registry) across all
sessions -- Strands/ag-ui-strands handles the per-thread agent lifecycle.

Subprocess credential lifecycle (module-level model, changed from the
previous "single subprocess launched once at startup, shared forever"
model):

At Python module import time (cold start), the session's Role_Set is NOT yet
known -- it only becomes available once a request's `X-Role-Names` header is
parsed by `extract_session_context`, which happens per-request in the
`/invocations` handler below. So the shared `MCPClient` is constructed (but
only minimally started, for tool-schema discovery) at import time with no
explicit per-role credentials via `gateway.manager.McpClientManager.
build_initial_client()`. The *same* `MCPClient` object is then handed to
the template `Agent`'s `tools=[...]`.

Later, the shared `SessionScopeAndRoleHook` (registered below,
`BeforeToolCallEvent`) resolves the *current* request's role on every
credential-requiring tool call and calls `McpClientManager.ensure_role()`,
which -- only when the role has actually changed since the subprocess was
last (re)started -- calls `boto3 sts:AssumeRole` and restarts the *same*
`MCPClient` instance's underlying subprocess with the assumed role's
credentials passed as `env=` at construction time (never via a post-startup
`os.environ` mutation; see `gateway/client.py`'s module docstring for why
that pattern was broken). Reusing the same `MCPClient` object (rather than
building a new one per role) is required because `ag_ui_strands.
StrandsAgent` snapshots the template Agent's tool list once, at
construction time -- see `gateway/manager.py` for the full rationale.

Because `src/app/api/copilotkit/route.ts` does not (yet) send the AgentCore
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header, a given microVM is not
guaranteed to serve only one role for its entire lifetime. `McpClientManager`
handles this defensively: if a request arrives with a role_name different
from the one the subprocess is currently running as, it tears down and
rebuilds with a fresh AssumeRole for the new role.

Rather than relying on `create_strands_app()` / `add_strands_fastapi_endpoint()`
(which have no access to the incoming request's HTTP headers), this module
defines the `/invocations` and `/ping` routes directly so that the per-request
`X-Role-Names` header can be extracted and published via `contextvars`
before the Strands agent run starts. The shared `SessionScopeAndRoleHook`
(registered below) reads that request-scoped context to resolve, per tool
call, which Role_Entry in the session's Role_Set to use, enforce that
Role_Entry's operation scope, and ensure the shared subprocess is running
with that role's credentials (see roles/hook.py and gateway/manager.py).

Requirements: 1.1, 2.6, 8.3
"""

import logging
import os

if os.getenv("LOCAL_DEV") == "1":
    os.environ["OTEL_SDK_DISABLED"] = "true"

import uvicorn
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_strands import StrandsAgent, StrandsAgentConfig
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from strands import Agent

from calc.tool import calculate
from clock.tool import convert_to_jst, get_current_datetime, time_ago
from context.session_context import extract_session_context
from gateway.manager import McpClientManager
from memory.session import get_memory_session_manager
from model.load import load_model
from prompts.system import build_system_prompt
from roles.hook import (
    AWS_CREDENTIAL_TOOLS,
    SessionScopeAndRoleHook,
    _strip_gateway_prefix,
    current_session_context,
)
from roles.tool_schema import RoleSelectingToolWrapper
from units.tool import humanize_bytes
from visualization.tool import emit_visualization

logger = logging.getLogger(__name__)

AWS_MCP_ENDPOINT = os.environ.get(
    "AWS_MCP_ENDPOINT", "https://aws-mcp.us-east-1.api.aws/mcp"
)
AWS_MCP_REGION = os.environ.get("AWS_MCP_REGION", "us-east-1")


def _build_template_agent(mcp_client_manager: McpClientManager) -> Agent:
    """Build the template agent with AWS MCP tools via mcp-proxy-for-aws.

    Builds the shared `MCPClient` (not yet credentialed for any particular
    role -- see module docstring) via `mcp_client_manager.build_initial_client()`
    and passes it to the Agent as a tool provider. Strands lazily starts
    this client (purely for tool-schema discovery) the first time
    `Agent(tools=[mcp_client])` processes it.

    Immediately after `Agent(...)` construction, every registered tool whose
    Gateway-prefix-normalized name is one of the four AWS-credential-requiring
    tools (`AWS_CREDENTIAL_TOOLS`) is swapped in-place, inside
    `agent.tool_registry.registry`, for a `RoleSelectingToolWrapper` around
    the original tool (see roles/tool_schema.py). This must happen here --
    before this function returns and before `ag_ui_strands.StrandsAgent(
    agent=_template_agent, ...)` is constructed at module scope below --
    because `StrandsAgent.__init__` snapshots
    `list(agent.tool_registry.registry.values())` once, at construction
    time; any registry mutation performed after that snapshot would never
    be picked up by tool calls made through the already-snapshotted list.

    Matching is done against the Gateway-prefix-normalized tool name (via
    `roles.hook._strip_gateway_prefix`), not the raw registry key, because
    tool names discovered through the AgentCore Gateway carry a
    `{target}___` prefix (e.g. `aws___call_aws`) that a bare
    `name in AWS_CREDENTIAL_TOOLS` check would never match -- see
    roles/hook.py's `AWS_CREDENTIAL_TOOLS` docstring for the same rationale
    applied there to `BeforeToolCallEvent` matching.

    Args:
        mcp_client_manager: The shared manager that owns the MCPClient's
            credential/subprocess lifecycle for the lifetime of this
            process.
    """
    mcp_client = mcp_client_manager.build_initial_client()

    logger.info("main.aws_mcp_agent_built", extra={"endpoint": AWS_MCP_ENDPOINT})
    system_prompt = build_system_prompt()

    agent = Agent(
        model=load_model(),
        system_prompt=system_prompt,
        tools=[
            mcp_client,
            emit_visualization,
            get_current_datetime,
            convert_to_jst,
            time_ago,
            humanize_bytes,
            calculate,
        ],
    )

    for name, tool in list(agent.tool_registry.registry.items()):
        if _strip_gateway_prefix(name) in AWS_CREDENTIAL_TOOLS:
            agent.tool_registry.registry[name] = RoleSelectingToolWrapper(tool)
            logger.info("main.role_selecting_wrapper_applied", extra={"tool_name": name})

    return agent


def session_manager_provider(input_data):
    """Provide AgentCore Memory session manager keyed by thread/user.

    ``input_data`` (AG-UI's ``RunAgentInput``) has no ``actor_id`` field --
    the previous implementation's ``getattr(input_data, "actor_id", None)``
    always returned ``None`` and every session silently fell back to a
    shared "default-user" actor_id, mixing conversations across Cognito
    users in Memory. The real per-request actor_id is extracted from the
    ``X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId`` header by
    ``extract_session_context`` (see context/session_context.py) and
    published via the ``current_session_context`` contextvar in the
    ``/invocations`` handler below, before this provider is invoked.
    """
    ctx = current_session_context.get()
    actor_id = (ctx.actor_id if ctx else None) or "default-user"
    return get_memory_session_manager(input_data.thread_id, actor_id)


config = StrandsAgentConfig(session_manager_provider=session_manager_provider)
_mcp_client_manager = McpClientManager(endpoint=AWS_MCP_ENDPOINT, region=AWS_MCP_REGION)
_template_agent = _build_template_agent(_mcp_client_manager)

agui_agent = StrandsAgent(
    agent=_template_agent,
    name="AWS_MCP_Agent",
    description="AWS operations assistant via mcp-proxy-for-aws",
    config=config,
    hooks=[SessionScopeAndRoleHook(_mcp_client_manager)],
)

app = FastAPI(title="AWS_MCP_Agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/invocations")
async def invocations(input_data: RunAgentInput, request: Request):
    """AG-UI agent endpoint."""
    ctx = extract_session_context(request.headers)
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_generator():
        token = current_session_context.set(ctx)
        try:
            async for event in agui_agent.run(input_data):
                yield encoder.encode(event)
        finally:
            current_session_context.reset(token)

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
    )


@app.get("/ping")
async def ping():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
