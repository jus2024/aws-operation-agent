"""Session context extraction from AgentCore Runtime request headers.

Extracts the selected Role_Set (a list of Role_Names) from headers passed by
the API Route. The API Route reads the available roles from the Role_Config
(DynamoDB `RoleConfig` table, see roles/config.py) and propagates the
user-selected Role_Set as a custom header.

Headers:
    X-Role-Names: A JSON-encoded array of Role_Name strings (see
        roles/config.py) that the Agent SHALL use as the set of Role_Entry
        candidates for tool calls in this session (the "Role_Set"). Absence,
        an empty value, or a JSON parse failure is NOT an error -- it
        resolves to ``role_names=()`` (an empty tuple, meaning "no
        Role_Set"). Elements that do not exist in the current Role_Config
        are excluded individually (with a warning logged) rather than
        failing the whole extraction.
        Whether an empty Role_Set (or a missing role_name parameter on a
        given tool call) blocks a given tool call is decided by the
        BeforeToolCallEvent hook (see roles/hook.py), not by this module.
    X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId: The Cognito ``sub`` of
        the authenticated user, propagated by the API Route from the
        verified Bearer token. AgentCore Memory scopes short-term memory by
        ``actor_id`` + ``session_id`` (see memory/session.py); without this
        header every session would fall back to a shared "default-user"
        actor_id, mixing conversations across Cognito users in Memory.
        Absence is NOT an error -- it resolves to ``actor_id=None`` and the
        caller (main.py's session_manager_provider) falls back to
        "default-user" for local/dev invocations that bypass the API Route
        (e.g. ``agentcore invoke``).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass

from roles.config import get_role_by_name

logger = logging.getLogger(__name__)

HEADER_ROLE_NAMES = "X-Role-Names"
HEADER_ACTOR_ID = "X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId"


@dataclass(frozen=True)
class SessionContext:
    """Immutable session context extracted from request headers.

    Attributes:
        role_names: The Role_Set for this session, as a tuple of
            Role_Name strings. An empty tuple means the X-Role-Names header
            was missing, empty, malformed JSON, or resolved to no valid
            Role_Name after filtering against the current Role_Config
            (Requirement 6.1). The permitted operation scope is not part of
            the session context -- it is derived per tool call from the
            selected Role_Entry (see roles/hook.py).
        actor_id: The Cognito sub of the authenticated user, or ``None`` if
            the X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId header was
            missing or empty. Used to scope AgentCore Memory (see
            memory/session.py); callers fall back to "default-user" when
            this is ``None``.
    """

    role_names: tuple[str, ...]
    actor_id: str | None = None


def extract_session_context(headers: Mapping[str, str]) -> SessionContext:
    """Extract session context from request headers.

    Args:
        headers: A dict-like mapping of header names to values.
                 Header lookup is case-insensitive.

    Returns:
        A frozen SessionContext with role_names (an empty tuple if the
        X-Role-Names header is absent, empty, malformed JSON, or resolves to
        no valid Role_Name) and actor_id (None if the
        X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId header is absent or
        empty). This function never raises -- a missing, malformed, or
        unresolvable header is not fatal at extraction time.
    """
    # Case-insensitive header lookup
    normalized = {k.lower(): v for k, v in headers.items()}

    raw_role_names = normalized.get(HEADER_ROLE_NAMES.lower(), "").strip()
    raw_actor_id = normalized.get(HEADER_ACTOR_ID.lower(), "").strip()

    role_names = _parse_role_names(raw_role_names)
    actor_id = raw_actor_id or None

    logger.info(
        "session_context.extracted",
        extra={"role_names": role_names, "actor_id": actor_id},
    )

    return SessionContext(role_names=role_names, actor_id=actor_id)


def _parse_role_names(raw_role_names: str) -> tuple[str, ...]:
    """Parse and validate the X-Role-Names header value.

    Returns an empty tuple (never raises) if the header is missing, empty,
    not valid JSON, not a JSON array, or resolves to no valid Role_Name.
    """
    if not raw_role_names:
        logger.info("session_context.missing_role_names")
        return ()

    try:
        parsed = json.loads(raw_role_names)
    except (json.JSONDecodeError, ValueError):
        logger.warning(
            "session_context.invalid_role_names_json",
            extra={"raw_role_names": raw_role_names},
        )
        return ()

    if not isinstance(parsed, list):
        logger.warning(
            "session_context.role_names_not_array",
            extra={"raw_role_names": raw_role_names},
        )
        return ()

    resolved: list[str] = []
    for candidate in parsed:
        if not isinstance(candidate, str) or not candidate:
            logger.warning(
                "session_context.invalid_role_name_element",
                extra={"candidate": candidate},
            )
            continue
        if get_role_by_name(candidate) is None:
            logger.warning(
                "session_context.unknown_role_name",
                extra={"role_name": candidate},
            )
            continue
        resolved.append(candidate)

    return tuple(resolved)
