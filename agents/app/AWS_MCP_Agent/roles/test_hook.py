"""Unit tests for the BeforeToolCallEvent hook's Gateway-prefix normalization.

Covers `_strip_gateway_prefix`, the helper added to fix the root-cause bug
where AgentCore Gateway namespaces tool names as `{target}___{tool}` (e.g.
`aws___call_aws`), which never matched the bare names in
`AWS_CREDENTIAL_TOOLS`, so `McpClientManager.ensure_role()` (STS AssumeRole
+ subprocess restart) was never invoked for Gateway-routed tool calls.
"""

from __future__ import annotations

import pytest

from roles.hook import AWS_CREDENTIAL_TOOLS, _strip_gateway_prefix


class TestStripGatewayPrefix:
    """Tests for _strip_gateway_prefix."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("aws___call_aws", "call_aws"),
            ("aws___run_script", "run_script"),
            ("aws___get_presigned_url", "get_presigned_url"),
            ("aws___get_tasks", "get_tasks"),
        ],
    )
    def test_strips_gateway_target_prefix(self, raw: str, expected: str) -> None:
        assert _strip_gateway_prefix(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "call_aws",
            "run_script",
            "get_presigned_url",
            "get_tasks",
            "some_other_tool",
        ],
    )
    def test_no_prefix_returns_unchanged(self, raw: str) -> None:
        """Bare tool names with no `___` separator are returned unchanged."""
        assert _strip_gateway_prefix(raw) == raw

    def test_empty_string_returns_unchanged(self) -> None:
        assert _strip_gateway_prefix("") == ""

    def test_multiple_separators_splits_on_last_occurrence(self) -> None:
        """rpartition splits on the *last* `___`, so a tool name that itself
        contains `___` still normalizes to everything after the final
        separator -- matching the Gateway's `{target}___{tool}` convention
        where the target name is always the prefix."""
        assert _strip_gateway_prefix("aws___sub___tool___call_aws") == "call_aws"
        assert _strip_gateway_prefix("a___b___c") == "c"

    def test_trailing_separator_with_no_remainder(self) -> None:
        """A trailing `___` with nothing after it strips to an empty string
        (rpartition still finds the separator, so the empty remainder wins)."""
        assert _strip_gateway_prefix("aws___") == ""

    def test_leading_separator_with_no_target(self) -> None:
        assert _strip_gateway_prefix("___call_aws") == "call_aws"

    def test_only_separator(self) -> None:
        assert _strip_gateway_prefix("___") == ""


class TestGatewayPrefixedCredentialToolMembership:
    """Regression coverage for the root-cause bug: Gateway-prefixed
    credential tool names must normalize to a name found in
    AWS_CREDENTIAL_TOOLS, so the hook's credential check actually fires
    instead of always early-returning."""

    @pytest.mark.parametrize(
        "raw",
        [
            "aws___call_aws",
            "aws___run_script",
            "aws___get_presigned_url",
            "aws___get_tasks",
        ],
    )
    def test_prefixed_credential_tool_name_matches_after_normalization(
        self, raw: str
    ) -> None:
        assert _strip_gateway_prefix(raw) in AWS_CREDENTIAL_TOOLS

    @pytest.mark.parametrize(
        "raw",
        [
            "aws___call_aws",
            "aws___run_script",
            "aws___get_presigned_url",
            "aws___get_tasks",
        ],
    )
    def test_prefixed_credential_tool_name_never_matches_before_normalization(
        self, raw: str
    ) -> None:
        """Documents the bug being fixed: the *raw* Gateway-prefixed name
        never matches AWS_CREDENTIAL_TOOLS directly."""
        assert raw not in AWS_CREDENTIAL_TOOLS

    def test_unrelated_prefixed_tool_still_not_a_credential_tool(self) -> None:
        assert _strip_gateway_prefix("aws___ListBuckets") not in AWS_CREDENTIAL_TOOLS
