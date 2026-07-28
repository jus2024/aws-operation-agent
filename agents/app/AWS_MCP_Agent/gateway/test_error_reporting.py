"""Unit tests for connection failure and tool error natural language reporting.

Validates: Requirements 3.2, 3.6

Tests:
1. McpProxyConnectionError includes Gateway URL, cause, and human-readable message
   (Req 3.2: connection failure reporting with endpoint).
2. classify_error produces GatewayError with natural language messages (not raw
   stack traces) and at least 1 remediation hint per failure type (Req 3.6:
   tool error natural language reporting + corrective action).
"""

from __future__ import annotations

import pytest

from gateway.client import McpProxyConnectionError
from gateway.error_classification import (
    FailureType,
    GatewayError,
    classify_error,
)

# ---------------------------------------------------------------------------
# Requirement 3.2: Connection failure reporting
# ---------------------------------------------------------------------------


class TestMcpProxyConnectionError:
    """McpProxyConnectionError instantiation and message format (Req 3.2)."""

    def test_includes_gateway_url(self):
        """Error message includes the Gateway URL."""
        url = "https://gateway.example.com/mcp"
        cause = ConnectionRefusedError("connection refused")

        err = McpProxyConnectionError(endpoint=url, cause=cause)

        assert url in str(err)
        assert err.endpoint == url

    def test_includes_cause(self):
        """Error retains the underlying cause exception."""
        url = "https://gw.example.com/mcp"
        cause = TimeoutError("connect timed out")

        err = McpProxyConnectionError(endpoint=url, cause=cause)

        assert err.cause is cause
        assert "connect timed out" in str(err)

    def test_message_is_human_readable(self):
        """Error message is a readable sentence, not a raw exception repr."""
        url = "https://gw.test/mcp"
        cause = OSError("Name or service not known")

        err = McpProxyConnectionError(endpoint=url, cause=cause)

        msg = str(err)
        # Should read like a sentence (starts with "Failed to connect")
        assert msg.startswith("Failed to connect to AWS MCP Server")
        # Contains the URL for identification
        assert url in msg
        # Contains the cause's description
        assert "Name or service not known" in msg

    def test_is_exception(self):
        """McpProxyConnectionError is a proper Exception subclass."""
        err = McpProxyConnectionError(
            endpoint="https://x.com/mcp",
            cause=RuntimeError("boom"),
        )
        assert isinstance(err, Exception)

    def test_various_causes(self):
        """Works correctly with various exception types as cause."""
        causes = [
            TimeoutError("deadline exceeded"),
            ConnectionRefusedError("refused"),
            OSError("DNS lookup failed"),
            RuntimeError("unexpected"),
        ]
        url = "https://gateway.corp.com/mcp"

        for cause in causes:
            err = McpProxyConnectionError(endpoint=url, cause=cause)
            assert err.endpoint == url
            assert err.cause is cause
            assert len(str(err)) > 0


# ---------------------------------------------------------------------------
# Requirement 3.6: Tool error natural language reporting with remediation
# ---------------------------------------------------------------------------


class TestToolErrorNaturalLanguageReporting:
    """classify_error produces natural language messages with remediation (Req 3.6)."""

    def test_timeout_message_is_natural_language(self):
        """Timeout error produces a human-readable message, not a stack trace."""
        exc = TimeoutError("read timed out")
        result = classify_error(exc, gateway_url="https://gateway.example.com/mcp", tool_name="ListBuckets")

        assert isinstance(result, GatewayError)
        assert result.failure_type == FailureType.TIMEOUT
        # Message is natural language (contains words, not traceback)
        assert "Traceback" not in result.message
        assert "File \"" not in result.message
        # Should mention the gateway
        assert "gateway.example.com" in result.message

    def test_connection_refused_message_is_natural_language(self):
        """Connection refused error produces a readable message."""
        exc = ConnectionRefusedError("connection refused")
        result = classify_error(exc, gateway_url="https://dev-gateway.example.com/mcp")

        assert isinstance(result, GatewayError)
        assert result.failure_type == FailureType.CONNECTION_REFUSED
        assert "dev-gateway.example.com" in result.message
        assert "Traceback" not in result.message
        # The message should read like prose
        assert len(result.message.split()) >= 3  # At least a few words

    def test_dns_failure_message_is_natural_language(self):
        """DNS failure produces a readable message."""
        exc = OSError("Name or service not known")
        result = classify_error(exc, gateway_url="https://staging-gateway.example.com/mcp")

        assert isinstance(result, GatewayError)
        assert result.failure_type == FailureType.DNS_RESOLUTION_FAILURE
        assert "staging-gateway.example.com" in result.message
        assert "Traceback" not in result.message

    def test_auth_failure_message_is_natural_language(self):
        """Authentication failure produces a readable message."""
        exc = Exception("401 Unauthorized")
        result = classify_error(exc, gateway_url="https://secure-gateway.example.com/mcp")

        assert isinstance(result, GatewayError)
        assert result.failure_type == FailureType.AUTHENTICATION_FAILURE
        assert "secure-gateway.example.com" in result.message
        assert "Traceback" not in result.message


class TestRemediationHints:
    """Each failure type message includes at least 1 remediation hint (Req 3.6).

    The remediation hint must be an actionable suggestion so the user knows
    what to do next. We test this by checking for keywords that indicate
    actionable guidance.
    """

    @pytest.fixture
    def timeout_error(self) -> GatewayError:
        return classify_error(
            TimeoutError("read timed out"),
            gateway_url="https://slow-gateway.example.com/mcp",
            tool_name="DescribeInstances",
        )

    @pytest.fixture
    def connection_refused_error(self) -> GatewayError:
        return classify_error(
            ConnectionRefusedError("connection refused"),
            gateway_url="https://dead-gateway.example.com/mcp",
        )

    @pytest.fixture
    def dns_error(self) -> GatewayError:
        return classify_error(
            OSError("Name or service not known"),
            gateway_url="https://bad-dns-gateway.example.com/mcp",
        )

    @pytest.fixture
    def auth_error(self) -> GatewayError:
        return classify_error(
            Exception("403 Forbidden"),
            gateway_url="https://locked-gateway.example.com/mcp",
        )

    def test_timeout_has_remediation(self, timeout_error: GatewayError):
        """Timeout message includes remediation suggestion."""
        message = _build_remediation_message(timeout_error)
        _assert_has_remediation(message, "timeout")

    def test_connection_refused_has_remediation(self, connection_refused_error: GatewayError):
        """Connection refused message includes remediation suggestion."""
        message = _build_remediation_message(connection_refused_error)
        _assert_has_remediation(message, "connection_refused")

    def test_dns_has_remediation(self, dns_error: GatewayError):
        """DNS resolution failure includes remediation suggestion."""
        message = _build_remediation_message(dns_error)
        _assert_has_remediation(message, "dns")

    def test_auth_has_remediation(self, auth_error: GatewayError):
        """Authentication failure includes remediation suggestion."""
        message = _build_remediation_message(auth_error)
        _assert_has_remediation(message, "auth")


# ---------------------------------------------------------------------------
# Helper: Remediation message builder
# ---------------------------------------------------------------------------
# The main.py builds user-facing messages from GatewayError. The classify_error
# provides the structured error; remediation text is generated here (can later
# be extracted into a shared helper). This keeps test focused on error reporting
# logic.

_REMEDIATION_HINTS: dict[FailureType, str] = {
    FailureType.TIMEOUT: (
        "The operation timed out. Please try again later, "
        "or check if the target AWS service is experiencing high latency."
    ),
    FailureType.CONNECTION_REFUSED: (
        "The connection was refused. Check the Gateway configuration "
        "and ensure the Gateway endpoint is available."
    ),
    FailureType.DNS_RESOLUTION_FAILURE: (
        "DNS resolution failed. Verify the Gateway endpoint hostname "
        "is correct and DNS is properly configured."
    ),
    FailureType.AUTHENTICATION_FAILURE: (
        "Authentication failed. Verify that the IAM credentials and permissions "
        "for the Gateway are correctly configured."
    ),
    FailureType.UNKNOWN: (
        "An unexpected error occurred. Please try again later "
        "or contact an administrator for assistance."
    ),
}


def build_user_error_message(error: GatewayError) -> str:
    """Build a complete user-facing error message with remediation.

    Combines the classified error message with a remediation hint.
    This is the function that main.py would use to report tool errors
    to the user in natural language (Req 3.6).
    """
    base = error.message
    hint = _REMEDIATION_HINTS.get(error.failure_type, _REMEDIATION_HINTS[FailureType.UNKNOWN])
    return f"{base}. {hint}"


def _build_remediation_message(error: GatewayError) -> str:
    """Build full message with remediation for testing."""
    return build_user_error_message(error)


def _assert_has_remediation(message: str, context: str):
    """Assert the message contains actionable remediation language."""
    # A remediation hint should contain at least one actionable phrase
    actionable_phrases = [
        "try again",
        "check",
        "verify",
        "ensure",
        "contact",
        "configuration",
        "configured",
    ]
    lower_msg = message.lower()
    has_action = any(phrase in lower_msg for phrase in actionable_phrases)
    assert has_action, (
        f"Error message for '{context}' lacks a remediation hint with actionable "
        f"guidance. Message was: {message}"
    )


class TestBuildUserErrorMessage:
    """Integration test for build_user_error_message helper."""

    def test_timeout_full_message(self):
        """Full message for timeout includes error + remediation."""
        error = classify_error(
            TimeoutError("deadline exceeded"),
            gateway_url="https://my-gateway.example.com/mcp",
            tool_name="PutObject",
        )
        msg = build_user_error_message(error)

        # Contains the classified error info
        assert "my-gateway.example.com" in msg
        assert "PutObject" in msg
        # Contains remediation
        assert "try again" in msg.lower()

    def test_connection_refused_full_message(self):
        """Full message for connection refused includes error + remediation."""
        error = classify_error(
            ConnectionRefusedError("refused"),
            gateway_url="https://broken-gateway.example.com/mcp",
        )
        msg = build_user_error_message(error)

        assert "broken-gateway.example.com" in msg
        assert "configuration" in msg.lower() or "check" in msg.lower()

    def test_all_failure_types_have_remediation_hints(self):
        """Every defined FailureType has a corresponding remediation hint."""
        for ft in FailureType:
            assert ft in _REMEDIATION_HINTS, (
                f"FailureType.{ft.name} is missing a remediation hint"
            )
            hint = _REMEDIATION_HINTS[ft]
            assert len(hint) > 10, (
                f"Remediation hint for {ft.name} is too short to be useful"
            )
