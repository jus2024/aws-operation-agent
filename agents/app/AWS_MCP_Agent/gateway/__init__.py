"""Gateway / MCP_Proxy integration modules for client connection and error classification."""

from gateway.client import (
    McpProxyConnectionError,
    build_aws_mcp_proxy_client,
    build_aws_mcp_proxy_transport_callable,
    build_gateway_client,
    discover_tools,
)
from gateway.error_classification import (
    FailureType,
    GatewayError,
    classify_error,
)

__all__ = [
    "McpProxyConnectionError",
    "build_aws_mcp_proxy_client",
    "build_aws_mcp_proxy_transport_callable",
    "build_gateway_client",
    "discover_tools",
    "FailureType",
    "GatewayError",
    "classify_error",
]
