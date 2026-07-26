"""Gateway / MCP error classification module.

Classifies failures from AgentCore Gateway and MCP Server interactions into
defined failure types and generates structured error information including
the Gateway URL and tool name (for timeouts).

Failure types:
    - timeout: Response not received within 30 seconds.
    - connection_refused: Target endpoint refused the connection.
    - dns_resolution_failure: DNS could not resolve the target hostname.
    - authentication_failure: Authentication with the target failed.
    - unknown: Failure does not match any known type.

All classifications are logged at warning level for observability.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class FailureType(Enum):
    """Defined failure types for Gateway/MCP errors."""

    TIMEOUT = "timeout"
    CONNECTION_REFUSED = "connection_refused"
    DNS_RESOLUTION_FAILURE = "dns_resolution_failure"
    AUTHENTICATION_FAILURE = "authentication_failure"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class GatewayError:
    """Structured representation of a Gateway/MCP failure.

    Attributes:
        failure_type: The classified failure type.
        gateway_url: The Gateway URL where the failure occurred.
        tool_name: The tool name that caused the failure (present for timeouts).
        message: A human-readable description of the failure.
    """

    failure_type: FailureType
    gateway_url: str
    tool_name: str | None = None
    message: str = ""


# Keywords used to classify exception types/messages into failure types.
_TIMEOUT_KEYWORDS: tuple[str, ...] = (
    "timeout",
    "timed out",
    "deadline exceeded",
    "read timed out",
    "connect timed out",
)

_CONNECTION_REFUSED_KEYWORDS: tuple[str, ...] = (
    "connection refused",
    "connect refused",
    "econnrefused",
    "connection reset",
)

_DNS_KEYWORDS: tuple[str, ...] = (
    "dns",
    "name resolution",
    "nodename nor servname",
    "getaddrinfo",
    "name or service not known",
    "temporary failure in name resolution",
)

_AUTH_KEYWORDS: tuple[str, ...] = (
    "authentication",
    "unauthorized",
    "403",
    "401",
    "forbidden",
    "access denied",
    "invalid credentials",
    "signature",
)


def _match_keywords(text: str, keywords: tuple[str, ...]) -> bool:
    """Check if any keyword appears in the lowercased text."""
    lower = text.lower()
    return any(kw in lower for kw in keywords)


def _classify_exception_type(exception: Exception) -> FailureType:
    """Classify based on exception type name."""
    type_name = type(exception).__name__.lower()

    if "timeout" in type_name:
        return FailureType.TIMEOUT
    if "connectionrefused" in type_name or "connectionerror" in type_name:
        return FailureType.CONNECTION_REFUSED
    if "dns" in type_name or "resolution" in type_name:
        return FailureType.DNS_RESOLUTION_FAILURE
    if "auth" in type_name or "permission" in type_name:
        return FailureType.AUTHENTICATION_FAILURE

    return FailureType.UNKNOWN


def _classify_exception_message(exception: Exception) -> FailureType:
    """Classify based on exception message content."""
    message = str(exception)
    if not message:
        return FailureType.UNKNOWN

    if _match_keywords(message, _TIMEOUT_KEYWORDS):
        return FailureType.TIMEOUT
    if _match_keywords(message, _CONNECTION_REFUSED_KEYWORDS):
        return FailureType.CONNECTION_REFUSED
    if _match_keywords(message, _DNS_KEYWORDS):
        return FailureType.DNS_RESOLUTION_FAILURE
    if _match_keywords(message, _AUTH_KEYWORDS):
        return FailureType.AUTHENTICATION_FAILURE

    return FailureType.UNKNOWN


def _build_message(
    failure_type: FailureType,
    gateway_url: str,
    tool_name: str | None,
    exception: Exception,
) -> str:
    """Generate a human-readable error message for the failure."""
    base_messages = {
        FailureType.TIMEOUT: (
            f"Request timed out for tool '{tool_name}' on gateway '{gateway_url}'"
            if tool_name
            else f"Request timed out on gateway '{gateway_url}'"
        ),
        FailureType.CONNECTION_REFUSED: (
            f"Connection refused by gateway '{gateway_url}'"
        ),
        FailureType.DNS_RESOLUTION_FAILURE: (
            f"DNS resolution failed for gateway '{gateway_url}'"
        ),
        FailureType.AUTHENTICATION_FAILURE: (
            f"Authentication failed for gateway '{gateway_url}'"
        ),
        FailureType.UNKNOWN: (
            f"Unknown error on gateway '{gateway_url}': {exception}"
        ),
    }
    return base_messages[failure_type]


def classify_error(
    exception: Exception,
    gateway_url: str,
    tool_name: str | None = None,
) -> GatewayError:
    """Classify a Gateway/MCP failure into a defined type.

    Inspects exception type and message to determine the failure type.
    Always includes the gateway_url in the result. For timeout errors,
    includes the tool_name if provided.

    Args:
        exception: The exception raised during the Gateway/MCP interaction.
        gateway_url: The Gateway URL where the failure occurred.
        tool_name: The tool name involved in the failure (included for timeouts).

    Returns:
        A GatewayError with the classified failure type, gateway URL, tool name
        (for timeouts), and a human-readable message.
    """
    # Try type-based classification first, fall back to message-based
    failure_type = _classify_exception_type(exception)
    if failure_type == FailureType.UNKNOWN:
        failure_type = _classify_exception_message(exception)

    # tool_name is included only for timeout errors per requirements
    effective_tool_name = tool_name if failure_type == FailureType.TIMEOUT else None

    message = _build_message(failure_type, gateway_url, effective_tool_name, exception)

    error = GatewayError(
        failure_type=failure_type,
        gateway_url=gateway_url,
        tool_name=effective_tool_name,
        message=message,
    )

    # Structured logging for failure observability
    logger.warning(
        "gateway.error_classified",
        extra={
            "failure_type": failure_type.value,
            "gateway_url": gateway_url,
            "tool_name": effective_tool_name,
            "exception_type": type(exception).__name__,
            "exception_message": str(exception),
            "error_message": message,
        },
    )

    return error
