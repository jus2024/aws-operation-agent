"""Unit tests for prompts.system module."""

from prompts.system import build_system_prompt


class TestBuildSystemPrompt:
    """Tests for build_system_prompt function."""

    def test_no_connection_details_embedded(self) -> None:
        """Prompt must not embed gateway URL, Role_ARN, or account ID (Requirement 8.3)."""
        prompt = build_system_prompt()
        assert "https://" not in prompt
        assert "Connected Gateway:" not in prompt
        assert "arn:aws:iam::" not in prompt

    def test_describes_role_set_mechanism(self) -> None:
        prompt = build_system_prompt()
        assert "Role_Set" in prompt
        assert "role_name" in prompt

    def test_scope_reference_covers_all_scopes(self) -> None:
        prompt = build_system_prompt()
        assert "READ-ONLY" in prompt
        assert "read and write operations" in prompt
        assert "administrative permissions" in prompt

    def test_readonly_reference_mentions_restriction(self) -> None:
        prompt = build_system_prompt()
        assert "MUST NOT perform any write operations" in prompt
        assert "new session" in prompt
        assert "readwrite" in prompt

    def test_no_fabrication_instruction(self) -> None:
        prompt = build_system_prompt()
        assert "Do NOT fabricate tool names" in prompt

    def test_unsupported_operation_guidance(self) -> None:
        """Prompt instructs agent to indicate unsupported ops and list categories."""
        prompt = build_system_prompt()
        assert "not supported" in prompt
        assert "categories of available tools" in prompt

    def test_no_other_targets_language(self) -> None:
        """Prompt should NOT contain old prefix-based target separation language."""
        prompt = build_system_prompt()
        assert "other connections/targets" not in prompt
        assert "other targets" not in prompt
        assert "Target=" not in prompt

    def test_available_tools_categories_listed(self) -> None:
        tools = [
            "ListBuckets",
            "DescribeInstances",
            "GetObject",
        ]
        prompt = build_system_prompt(tools)
        assert "S3 (Storage)" in prompt
        assert "EC2 (Compute)" in prompt

    def test_no_tools_section_when_none(self) -> None:
        prompt = build_system_prompt(None)
        assert "Available tool categories" not in prompt

    def test_no_tools_section_when_empty(self) -> None:
        prompt = build_system_prompt([])
        assert "Available tool categories" not in prompt

    def test_tools_with_unrecognized_names_omitted(self) -> None:
        tools = ["SomeUnknownTool"]
        prompt = build_system_prompt(tools)
        # Unrecognized tools don't produce categories
        assert "Available tool categories" not in prompt

    def test_pure_function_no_side_effects(self) -> None:
        """Calling twice with same args produces same result."""
        result1 = build_system_prompt(["ListBuckets"])
        result2 = build_system_prompt(["ListBuckets"])
        assert result1 == result2

    def test_returns_string(self) -> None:
        result = build_system_prompt()
        assert isinstance(result, str)
        assert len(result) > 0
