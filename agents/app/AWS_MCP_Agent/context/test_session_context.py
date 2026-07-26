"""Unit tests for session context extraction."""

import json
from unittest.mock import patch

import pytest

from context.session_context import (
    extract_session_context,
)
from roles.config import RoleConfig

_ADMIN_ROLE = RoleConfig(
    name="admin",
    display_name="Admin",
    account_label="Account A",
    role_arn="arn:aws:iam::111122223333:role/AgentMCPAdminRole",
    scope="admin",
    is_active=True,
)

_READONLY_ROLE = RoleConfig(
    name="readonly-b",
    display_name="ReadOnly",
    account_label="Account B",
    role_arn="arn:aws:iam::444455556666:role/AgentMCPReadOnlyRole",
    scope="readonly",
    is_active=True,
)

_KNOWN_ROLES = {"admin": _ADMIN_ROLE, "readonly-b": _READONLY_ROLE}


def _fake_get_role_by_name(name: str) -> RoleConfig | None:
    """Stand-in for roles.config.get_role_by_name that only knows the fixtures above."""
    return _KNOWN_ROLES.get(name)


@patch("context.session_context.get_role_by_name", side_effect=_fake_get_role_by_name)
class TestExtractSessionContext:
    """Tests for extract_session_context function.

    ``get_role_by_name`` is patched for every test so that Role_Name
    resolution is independent of the real Role_Config_Table contents --
    only "admin" and "readonly-b" are treated as known.
    """

    def test_extracts_single_role(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["admin"])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin",)

    def test_extracts_multiple_roles(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["admin", "readonly-b"])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin", "readonly-b")

    def test_case_insensitive_header_name(self, mock_get_role):
        headers = {"x-role-names": json.dumps(["admin"])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin",)

    def test_missing_header_resolves_to_empty_tuple(self, mock_get_role):
        ctx = extract_session_context({})
        assert ctx.role_names == ()

    def test_empty_header_resolves_to_empty_tuple(self, mock_get_role):
        headers = {"X-Role-Names": ""}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ()

    def test_whitespace_header_resolves_to_empty_tuple(self, mock_get_role):
        headers = {"X-Role-Names": "   "}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ()

    def test_invalid_json_resolves_to_empty_tuple(self, mock_get_role):
        headers = {"X-Role-Names": "not-json"}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ()

    def test_non_array_json_resolves_to_empty_tuple(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps({"role": "admin"})}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ()

    def test_unknown_role_name_excluded(self, mock_get_role):
        headers = {
            "X-Role-Names": json.dumps(["admin", "does-not-exist-in-role-config"])
        }
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin",)

    def test_all_unknown_role_names_resolve_to_empty_tuple(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["does-not-exist"])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ()

    def test_non_string_elements_excluded(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["admin", 123, None])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin",)

    def test_empty_string_elements_excluded(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["admin", ""])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin",)

    def test_duplicate_role_names_preserved_in_order(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["admin", "admin"])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin", "admin")

    def test_session_context_is_frozen(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps(["admin"])}
        ctx = extract_session_context(headers)
        with pytest.raises(AttributeError):
            ctx.role_names = ("other",)  # type: ignore[misc]

    def test_empty_array_resolves_to_empty_tuple(self, mock_get_role):
        headers = {"X-Role-Names": json.dumps([])}
        ctx = extract_session_context(headers)
        assert ctx.role_names == ()

    def test_extracts_actor_id(self, mock_get_role):
        headers = {"X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId": "cognito-sub-123"}
        ctx = extract_session_context(headers)
        assert ctx.actor_id == "cognito-sub-123"

    def test_case_insensitive_actor_id_header_name(self, mock_get_role):
        headers = {"x-amzn-bedrock-agentcore-runtime-custom-userid": "cognito-sub-123"}
        ctx = extract_session_context(headers)
        assert ctx.actor_id == "cognito-sub-123"

    def test_missing_actor_id_header_resolves_to_none(self, mock_get_role):
        ctx = extract_session_context({})
        assert ctx.actor_id is None

    def test_empty_actor_id_header_resolves_to_none(self, mock_get_role):
        headers = {"X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId": ""}
        ctx = extract_session_context(headers)
        assert ctx.actor_id is None

    def test_whitespace_actor_id_header_resolves_to_none(self, mock_get_role):
        headers = {"X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId": "   "}
        ctx = extract_session_context(headers)
        assert ctx.actor_id is None

    def test_actor_id_independent_of_role_names(self, mock_get_role):
        headers = {
            "X-Role-Names": json.dumps(["admin"]),
            "X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId": "cognito-sub-123",
        }
        ctx = extract_session_context(headers)
        assert ctx.role_names == ("admin",)
        assert ctx.actor_id == "cognito-sub-123"
