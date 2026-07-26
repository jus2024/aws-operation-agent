"""Property-based tests for scope rejection message generation.

**Validates: Requirements 3.8, 7.4**

Verifies that for any rejected write tool in a readonly session, the generated
rejection message contains: the operation name, the scope constraint, and a
suggestion to start a new session with readwrite scope.

Tag: Feature: gateway-direct-connect, Property 3: スコープ拒否メッセージの内容
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from scope.enforcement import build_rejection_message

# --- Strategies ---

# Tool names: arbitrary non-empty strings (no target prefix — single-target Gateway)
_any_tool_name = st.text(
    alphabet=st.characters(categories=("L", "N", "P")),
    min_size=1,
    max_size=60,
).filter(lambda s: s.strip() != "")

# Scope: "readonly" with variations (whitespace/case) since rejections only
# happen in readonly sessions
_readonly_scope_variants = st.one_of(
    st.just("readonly"),
    st.just("READONLY"),
    st.just("ReadOnly"),
    st.just("  readonly  "),
    st.just(" ReadOnly "),
)


# --- Property Tests ---


@pytest.mark.hypothesis
class TestRejectionMessageProperties:
    """Property 3: スコープ拒否メッセージの内容

    **Validates: Requirements 3.8, 7.4**
    """

    @settings(max_examples=100)
    @given(tool_name=_any_tool_name, scope=_readonly_scope_variants)
    def test_message_contains_tool_name(self, tool_name: str, scope: str) -> None:
        """Generated message MUST contain the rejected tool/operation name."""
        message = build_rejection_message(tool_name, scope)
        assert tool_name in message, (
            f"Message should contain tool_name {tool_name!r}, got: {message!r}"
        )

    @settings(max_examples=100)
    @given(tool_name=_any_tool_name, scope=_readonly_scope_variants)
    def test_message_contains_scope_normalized(self, tool_name: str, scope: str) -> None:
        """Generated message MUST contain the scope constraint (normalized to lowercase)."""
        message = build_rejection_message(tool_name, scope)
        normalized_scope = scope.strip().lower()
        assert normalized_scope in message, (
            f"Message should contain normalized scope {normalized_scope!r}, got: {message!r}"
        )

    @settings(max_examples=100)
    @given(tool_name=_any_tool_name, scope=_readonly_scope_variants)
    def test_message_contains_readwrite_suggestion(self, tool_name: str, scope: str) -> None:
        """Generated message MUST contain 'readwrite' as a suggestion for a new session."""
        message = build_rejection_message(tool_name, scope)
        assert "readwrite" in message.lower(), (
            f"Message should suggest readwrite scope, got: {message!r}"
        )

    @settings(max_examples=100)
    @given(tool_name=_any_tool_name, scope=_readonly_scope_variants)
    def test_message_contains_new_session_suggestion(self, tool_name: str, scope: str) -> None:
        """Generated message MUST suggest starting a new session."""
        message = build_rejection_message(tool_name, scope)
        message_lower = message.lower()
        assert "new session" in message_lower or "start a new" in message_lower, (
            f"Message should suggest starting a new session, got: {message!r}"
        )
