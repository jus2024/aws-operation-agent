"""Property-based tests for gateway/MCP error classification.

Feature: gateway-direct-connect, Property 1: エラーの分類と識別子の付与
Validates: Requirements 1.4, 1.5

Verifies that for any failure input (timeout / connection refused / DNS /
authentication / unknown), the generated error is classified into a defined
FailureType, always contains the Gateway URL, and for timeouts includes the
tool name when provided.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from gateway.error_classification import (
    FailureType,
    GatewayError,
    classify_error,
)

# --- Strategies ---

# Gateway URL: valid HTTPS URL pattern
gateway_urls = st.from_regex(
    r"https://[a-z][a-z0-9\-]{1,40}\.[a-z]{2,6}/mcp",
    fullmatch=True,
)

# Tool name: optional non-empty string
tool_names = st.one_of(st.none(), st.text(min_size=1, max_size=60))

# Timeout exceptions (type-based classification)
timeout_exceptions = st.one_of(
    st.just(TimeoutError("request timed out")),
    st.just(TimeoutError("deadline exceeded")),
    st.just(TimeoutError()),
)

# Connection refused exceptions (type-based classification)
connection_refused_exceptions = st.one_of(
    st.just(ConnectionRefusedError("connection refused")),
    st.just(ConnectionRefusedError()),
    st.just(ConnectionError("connection refused by peer")),
)

# DNS resolution failure exceptions (message-based classification)
dns_exceptions = st.one_of(
    st.just(OSError("DNS resolution failed")),
    st.just(OSError("Name resolution failed")),
    st.just(OSError("nodename nor servname provided")),
    st.just(OSError("getaddrinfo failed")),
    st.just(OSError("Name or service not known")),
    st.just(OSError("Temporary failure in name resolution")),
)

# Authentication failure exceptions (message-based classification)
auth_exceptions = st.one_of(
    st.just(PermissionError("authentication failed")),
    st.just(Exception("Unauthorized access")),
    st.just(Exception("403 Forbidden")),
    st.just(Exception("401 Unauthorized")),
    st.just(Exception("Access denied")),
    st.just(Exception("Invalid credentials")),
)

# Generic/unknown exceptions (should classify as UNKNOWN)
unknown_exceptions = st.one_of(
    st.just(Exception("something went wrong")),
    st.just(RuntimeError("unexpected state")),
    st.just(ValueError("invalid input")),
    st.just(Exception("")),
)

# Combined: any failure exception
all_exceptions = st.one_of(
    timeout_exceptions,
    connection_refused_exceptions,
    dns_exceptions,
    auth_exceptions,
    unknown_exceptions,
)


# --- Property Test ---


@settings(max_examples=200)
@given(
    exception=all_exceptions,
    gateway_url=gateway_urls,
    tool_name=tool_names,
)
def test_error_classification_properties(
    exception: Exception,
    gateway_url: str,
    tool_name: str | None,
):
    """Property 1: エラーの分類と識別子の付与

    For any failure exception and gateway_url:
    1. classify_error returns a GatewayError with a valid FailureType
    2. The returned GatewayError always contains the gateway_url
    3. When failure_type is TIMEOUT and tool_name was provided, the result
       includes tool_name
    4. When failure_type is NOT TIMEOUT, tool_name is None in the result
    5. The message is always a non-empty string

    Validates: Requirements 1.4, 1.5
    """
    result = classify_error(exception, gateway_url, tool_name)

    # Result is a GatewayError
    assert isinstance(result, GatewayError)

    # 1. failure_type is one of the defined FailureType values
    assert result.failure_type in FailureType, (
        f"Unexpected failure_type: {result.failure_type}"
    )

    # 2. gateway_url is always present in the result
    assert result.gateway_url == gateway_url, (
        f"Expected gateway_url '{gateway_url}', got '{result.gateway_url}'"
    )

    # 3. For TIMEOUT with tool_name provided, result includes tool_name
    if result.failure_type == FailureType.TIMEOUT and tool_name is not None:
        assert result.tool_name == tool_name, (
            f"TIMEOUT with tool_name='{tool_name}' should include tool_name, "
            f"got '{result.tool_name}'"
        )

    # 4. For non-TIMEOUT, tool_name is always None
    if result.failure_type != FailureType.TIMEOUT:
        assert result.tool_name is None, (
            f"Non-TIMEOUT failure_type '{result.failure_type.value}' should have "
            f"tool_name=None, got '{result.tool_name}'"
        )

    # 5. message is always a non-empty string
    assert isinstance(result.message, str), (
        f"Expected message to be str, got {type(result.message)}"
    )
    assert len(result.message) > 0, "message must be a non-empty string"
