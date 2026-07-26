"""Pure helpers for deriving mcp-proxy-for-aws multi-profile configuration.

`build_proxy_profiles_env` derives the value intended for the
`AWS_MCP_PROXY_PROFILES` environment variable (or an equivalent
`--profile` argument list) from the Connection catalog's `awsProfileName`
values. It is a pure function with no side effects, intended to be called
from operational documentation / deployment scripts (see Requirement 1.3
and the O2 operator task in tasks.md) rather than from the running Agent
itself.
"""

from __future__ import annotations

from collections.abc import Iterable


def build_proxy_profiles_env(profile_names: Iterable[str]) -> str:
    """Build the AWS_MCP_PROXY_PROFILES value from a list of profile names.

    Each value is trimmed. Empty or whitespace-only values are excluded.
    Duplicates are removed while preserving first-occurrence order. The
    remaining values are joined with a single space, matching the format
    `mcp-proxy-for-aws` expects for AWS_MCP_PROXY_PROFILES.

    Args:
        profile_names: An iterable of raw profile name values (e.g. the
            `awsProfileName` field of every Connection catalog entry).
            Values may be empty, whitespace-only, or duplicated.

    Returns:
        A space-separated string of distinct, trimmed, non-empty profile
        names in first-occurrence order. Returns an empty string if no
        non-empty values are present.
    """
    seen: set[str] = set()
    ordered: list[str] = []

    for raw in profile_names:
        trimmed = raw.strip()
        if not trimmed:
            continue
        if trimmed in seen:
            continue
        seen.add(trimmed)
        ordered.append(trimmed)

    return " ".join(ordered)
