"""Property-based tests for operation scope enforcement.

**Validates: Requirements 3.7, 7.2, 7.3**

Verifies that for any (tool, scope) pair, scope enforcement returns correct
allow/deny per rules, and the decision does NOT depend on message content.

Tag: Feature: gateway-direct-connect, Property 2: 操作スコープの強制
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from scope.enforcement import WRITE_VERBS, is_allowed, is_write_tool

# --- Strategies ---

# Read-only tool names: guaranteed to NOT contain any write verb
_READ_SAFE_PREFIXES = (
    "List",
    "Describe",
    "Get",
    "Head",
    "Query",
    "Scan",
    "Search",
    "Check",
    "Lookup",
    "Fetch",
)

_read_tools = st.sampled_from(_READ_SAFE_PREFIXES).flatmap(
    lambda prefix: st.text(
        alphabet=st.characters(categories=("L", "N")),
        min_size=0,
        max_size=15,
    )
    .filter(
        lambda suffix, p=prefix: not any(
            verb in (p + suffix).lower() for verb in WRITE_VERBS
        )
    )
    .map(lambda suffix, p=prefix: p + suffix)
)

# Write tool names: guaranteed to contain a write verb
_write_tools = st.sampled_from(WRITE_VERBS).flatmap(
    lambda verb: st.tuples(
        st.text(
            alphabet=st.characters(categories=("Lu",)), min_size=0, max_size=5
        ),
        st.just(verb.capitalize()),
        st.text(
            alphabet=st.characters(categories=("L", "N")),
            min_size=0,
            max_size=10,
        ),
    ).map(lambda parts: parts[0] + parts[1] + parts[2])
)

# Any tool (write or read)
_any_tool = st.one_of(_write_tools, _read_tools)

# Scope strategies
_readonly_scope = st.just("readonly")
_readwrite_scope = st.sampled_from(["readwrite", "admin"])
_all_scopes = st.sampled_from(["readonly", "readwrite", "admin"])

# Arbitrary message content (used to verify non-dependency)
_arbitrary_message = st.text(min_size=0, max_size=200)


# --- Property Tests ---


@pytest.mark.hypothesis
class TestScopeEnforcementProperties:
    """Feature: gateway-direct-connect, Property 2: 操作スコープの強制

    **Validates: Requirements 3.7, 7.2, 7.3**
    """

    @settings(max_examples=100)
    @given(tool=_write_tools, scope=_readonly_scope)
    def test_readonly_rejects_write_tools(self, tool: str, scope: str) -> None:
        """readonly scope MUST reject write-classified tools."""
        assert is_write_tool(tool) is True, f"Precondition: {tool!r} should be write"
        assert is_allowed(tool, scope) is False

    @settings(max_examples=100)
    @given(tool=_read_tools, scope=_readonly_scope)
    def test_readonly_allows_read_tools(self, tool: str, scope: str) -> None:
        """readonly scope MUST allow read-classified tools."""
        assert is_write_tool(tool) is False, f"Precondition: {tool!r} should be read"
        assert is_allowed(tool, scope) is True

    @settings(max_examples=100)
    @given(tool=_any_tool, scope=_readwrite_scope)
    def test_readwrite_admin_allows_all_tools(self, tool: str, scope: str) -> None:
        """readwrite and admin scopes MUST allow ALL tools regardless of classification."""
        assert is_allowed(tool, scope) is True

    @settings(max_examples=100)
    @given(tool=_any_tool, scope=_all_scopes, msg1=_arbitrary_message, msg2=_arbitrary_message)
    def test_decision_independent_of_message_content(
        self, tool: str, scope: str, msg1: str, msg2: str
    ) -> None:
        """Decision MUST be deterministic: same (tool, scope) always yields same result,
        regardless of any surrounding message content."""
        result1 = is_allowed(tool, scope)
        result2 = is_allowed(tool, scope)
        # Call multiple times with different "context" (msg1/msg2 unused by function)
        # to demonstrate the function signature does not accept or use message content
        assert result1 == result2, (
            f"Non-deterministic result for ({tool!r}, {scope!r}): {result1} != {result2}"
        )
        # Additionally verify the result matches the expected rule
        if scope.strip().lower() in ("readwrite", "admin"):
            assert result1 is True
        elif is_write_tool(tool):
            assert result1 is False
        else:
            assert result1 is True
