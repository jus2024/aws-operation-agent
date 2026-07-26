"""Unit tests for operation scope enforcement module."""

from __future__ import annotations

import pytest

from scope.enforcement import is_allowed, is_write_tool


class TestIsWriteTool:
    """Tests for is_write_tool classification."""

    @pytest.mark.parametrize(
        "tool_name",
        [
            "CreateBucket",
            "UpdateFunction",
            "DeleteTable",
            "PutObject",
            "ModifyCluster",
            "RemoveTargets",
            "AttachPolicy",
            "DetachVolume",
            "StartInstances",
            "StopInstances",
            "TerminateInstances",
            "RunTask",
            "EnableAlarm",
            "DisableAlarm",
        ],
    )
    def test_write_verbs_detected(self, tool_name: str) -> None:
        assert is_write_tool(tool_name) is True

    @pytest.mark.parametrize(
        "tool_name",
        [
            "ListBuckets",
            "DescribeInstances",
            "GetObject",
            "HeadBucket",
            "ListFunctions",
            "DescribeTags",
        ],
    )
    def test_read_tools_not_classified_as_write(self, tool_name: str) -> None:
        assert is_write_tool(tool_name) is False

    def test_empty_tool_name_is_conservative(self) -> None:
        """Empty tool name is treated as write (conservative default)."""
        assert is_write_tool("") is True

    def test_case_insensitive_verb_matching(self) -> None:
        assert is_write_tool("createBucket") is True
        assert is_write_tool("CREATEBUCKET") is True
        assert is_write_tool("Create_Bucket") is True

    def test_verb_as_substring(self) -> None:
        """Verbs are detected as substrings of the tool name."""
        assert is_write_tool("AdminCreateUser") is True
        assert is_write_tool("BatchDeleteItems") is True


class TestIsAllowed:
    """Tests for is_allowed scope enforcement."""

    def test_readonly_rejects_write_tools(self) -> None:
        assert is_allowed("CreateBucket", "readonly") is False
        assert is_allowed("DeleteTable", "readonly") is False

    def test_readonly_allows_read_tools(self) -> None:
        assert is_allowed("ListBuckets", "readonly") is True
        assert is_allowed("DescribeInstances", "readonly") is True

    def test_readwrite_allows_all(self) -> None:
        assert is_allowed("CreateBucket", "readwrite") is True
        assert is_allowed("ListBuckets", "readwrite") is True
        assert is_allowed("DeleteTable", "readwrite") is True

    def test_admin_allows_all(self) -> None:
        assert is_allowed("CreateBucket", "admin") is True
        assert is_allowed("ListBuckets", "admin") is True
        assert is_allowed("DeleteTable", "admin") is True

    def test_unknown_scope_treated_as_readonly(self) -> None:
        """Unknown scope values fall back to readonly (fail-safe)."""
        assert is_allowed("CreateBucket", "unknown") is False
        assert is_allowed("ListBuckets", "unknown") is True

    def test_empty_scope_treated_as_readonly(self) -> None:
        assert is_allowed("CreateBucket", "") is False
        assert is_allowed("ListBuckets", "") is True

    def test_scope_case_insensitive(self) -> None:
        assert is_allowed("CreateBucket", "ReadWrite") is True
        assert is_allowed("CreateBucket", "READONLY") is False
        assert is_allowed("CreateBucket", "Admin") is True

    def test_scope_whitespace_stripped(self) -> None:
        assert is_allowed("CreateBucket", "  readwrite  ") is True
        assert is_allowed("CreateBucket", " readonly ") is False

    def test_pure_function_no_message_dependency(self) -> None:
        """Verify the function is deterministic given the same inputs."""
        # Same inputs should always produce the same output
        for _ in range(10):
            assert is_allowed("CreateBucket", "readonly") is False
            assert is_allowed("ListBuckets", "readonly") is True
            assert is_allowed("CreateBucket", "readwrite") is True


class TestBuildRejectionMessage:
    """Tests for build_rejection_message scope violation message."""

    def test_message_contains_tool_name(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("CreateBucket", "readonly")
        assert "CreateBucket" in msg

    def test_message_contains_scope_constraint(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("DeleteTable", "readonly")
        assert "readonly" in msg

    def test_message_contains_readwrite_suggestion(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("CreateBucket", "readonly")
        assert "readwrite" in msg

    def test_message_contains_new_session_suggestion(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("PutObject", "readonly")
        assert "new session" in msg.lower()

    def test_message_with_empty_scope_defaults_to_readonly(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("CreateBucket", "")
        assert "readonly" in msg

    def test_message_normalizes_scope_case(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("CreateBucket", "ReadOnly")
        assert "readonly" in msg

    def test_message_strips_scope_whitespace(self) -> None:
        from scope.enforcement import build_rejection_message

        msg = build_rejection_message("CreateBucket", "  readonly  ")
        assert "readonly" in msg
        assert "  readonly  " not in msg

    def test_message_all_required_elements_present(self) -> None:
        """Verify all three required elements are present in one message."""
        from scope.enforcement import build_rejection_message

        tool = "TerminateInstances"
        scope = "readonly"
        msg = build_rejection_message(tool, scope)

        # 1. Rejected operation name
        assert tool in msg
        # 2. Current scope constraint
        assert scope in msg
        # 3. Suggestion to start a new session with readwrite scope
        assert "readwrite" in msg
        assert "session" in msg.lower()
