"""Role configuration loading for direct STS AssumeRole switching.

Available AWS roles are declared as Role_Entry records in the RoleConfig
DynamoDB table (Amplify Gen 2 Data_Model), rather than as a JSON blob in an
environment variable (Requirement 1.1). Each Role_Entry carries a unique
Role_Name, a human-readable display name, an Account_Label identifying the
target AWS account, the IAM Role_ARN to assume, the role's Operation_Scope,
and an Is_Active flag.

Unlike the previous ``AGENT_ROLES`` environment-variable approach (parsed
once at import time), this module reads Role_Config from DynamoDB via
`roles/store.py` and caches the result for a short TTL (default 30 seconds,
configurable via the ``ROLE_CONFIG_CACHE_TTL_SECONDS`` environment
variable). This lets Role_Entry additions, edits, and logical deletions made
through the Role_Config maintenance screen become visible to new
Chat_Session creations without redeploying the Agent (Requirement 1's
"without a redeployment" goal, Requirement 8.7).

Every failure mode -- a malformed Role_Entry, zero valid-and-active
Role_Entry records, or a DynamoDB read failure -- is handled by logging an
error and falling back to either the previous cached value (if one exists)
or an empty list (Requirement 1.3, 1.5) rather than raising -- callers
(e.g. the BeforeToolCallEvent hook) are responsible for refusing tool calls
that require AWS credentials when no role could be resolved.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass

from roles import store

logger = logging.getLogger(__name__)

ENV_VAR_ROLE_CONFIG_CACHE_TTL_SECONDS = "ROLE_CONFIG_CACHE_TTL_SECONDS"
DEFAULT_CACHE_TTL_SECONDS = 30.0

VALID_SCOPES = frozenset({"readonly", "readwrite", "admin"})
"""The only valid values for RoleConfig.scope (Requirement 1.1)."""

_REQUIRED_STRING_FIELDS: tuple[str, ...] = ("name", "displayName", "accountLabel", "roleArn", "scope")


@dataclass(frozen=True)
class RoleConfig:
    """A single Role_Entry loaded from the Role_Config_Table.

    Attributes:
        name: The Role_Name identifier (e.g. "admin", "readonly"). Stored on
            Chat_Session records and used to resolve the role at tool-call
            time. Unique within Role_Config (Requirement 1.1).
        display_name: Human-readable name shown to the user (e.g. "Admin").
        account_label: Display label identifying the AWS account this
            Role_Entry targets.
        role_arn: The IAM Role_ARN that STS AssumeRole is called with.
        scope: The Operation_Scope for this role. One of "readonly",
            "readwrite", or "admin" (Requirement 1.1).
        is_active: Whether this Role_Entry is currently selectable. A
            logically deleted Role_Entry (Is_Active = false) is never
            offered as a selection candidate (Requirement 1.8).
    """

    name: str
    display_name: str
    account_label: str
    role_arn: str
    scope: str
    is_active: bool


def _cache_ttl_seconds() -> float:
    """Read the configured TTL cache duration, in seconds.

    Returns:
        The value of the ``ROLE_CONFIG_CACHE_TTL_SECONDS`` environment
        variable parsed as a non-negative float, or
        ``DEFAULT_CACHE_TTL_SECONDS`` if the variable is unset, empty, or
        not a valid float.
    """
    raw = os.environ.get(ENV_VAR_ROLE_CONFIG_CACHE_TTL_SECONDS, "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL_SECONDS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_CACHE_TTL_SECONDS


def _parse_entry(entry: object, index: int) -> RoleConfig | None:
    """Validate and convert a single raw DynamoDB item into a RoleConfig.

    Args:
        entry: The raw DynamoDB item (a plain ``dict`` as returned by
            boto3's DynamoDB resource ``Scan``) at this position in the
            scan result.
        index: The entry's position in the scanned item list, used only for
            log messages.

    Returns:
        A RoleConfig if the entry is a well-formed object with all required
        string fields present and a valid scope, otherwise None. The
        ``isActive`` field is read defensively: if it is missing entirely,
        ``is_active`` is set to False rather than raising or defaulting to
        True (Requirement 1.8's "never offered as a selection candidate"
        intent extends to malformed/missing Is_Active values).
    """
    if not isinstance(entry, dict):
        logger.error(
            "roles.config.invalid_entry",
            extra={"index": index, "reason": "not_an_object"},
        )
        return None

    missing = [field for field in _REQUIRED_STRING_FIELDS if not entry.get(field)]
    if missing:
        logger.error(
            "roles.config.invalid_entry",
            extra={"index": index, "reason": "missing_fields", "missing": missing},
        )
        return None

    name = entry["name"]
    display_name = entry["displayName"]
    account_label = entry["accountLabel"]
    role_arn = entry["roleArn"]
    scope = entry["scope"]

    if not all(
        isinstance(value, str) for value in (name, display_name, account_label, role_arn, scope)
    ):
        logger.error(
            "roles.config.invalid_entry",
            extra={"index": index, "reason": "non_string_field"},
        )
        return None

    normalized_scope = scope.strip().lower()
    if normalized_scope not in VALID_SCOPES:
        logger.error(
            "roles.config.invalid_entry",
            extra={"index": index, "reason": "invalid_scope", "scope": scope},
        )
        return None

    is_active = entry.get("isActive")
    if not isinstance(is_active, bool):
        # Missing or malformed isActive is treated defensively as False
        # (Requirement 1.8) rather than raising or defaulting to True.
        is_active = False

    return RoleConfig(
        name=name,
        display_name=display_name,
        account_label=account_label,
        role_arn=role_arn,
        scope=normalized_scope,
        is_active=is_active,
    )


def _parse_items(items: list[dict]) -> list[RoleConfig]:
    """Validate and de-duplicate a list of raw DynamoDB Role_Entry items.

    Applies per-entry field validation (via `_parse_entry`) and then a
    Role_Name uniqueness check across the entire item list, regardless of
    each entry's Is_Active value (Requirement 1.1's "unique within
    Role_Config", applied as a defensive secondary check on the Agent side
    -- the primary uniqueness guarantee is enforced by the Role_Config
    maintenance screen's client-side validation). A duplicate Role_Name is
    resolved by keeping only the first occurrence and excluding every
    subsequent entry sharing that name, with an error logged for each
    excluded duplicate (Requirement 1.3).

    Args:
        items: The raw DynamoDB items as returned by
            `roles.store.scan_role_config_items()`.

    Returns:
        The list of validated, de-duplicated RoleConfig entries. This list
        is not yet filtered by `is_active` -- callers that need only active
        entries must filter separately (see `get_role_configs`).
    """
    seen_names: set[str] = set()
    role_configs: list[RoleConfig] = []

    for index, entry in enumerate(items):
        role_config = _parse_entry(entry, index)
        if role_config is None:
            continue

        if role_config.name in seen_names:
            logger.error(
                "roles.config.duplicate_name",
                extra={"index": index, "name": role_config.name},
            )
            continue

        seen_names.add(role_config.name)
        role_configs.append(role_config)

    return role_configs


_cache_lock = threading.Lock()
_cached_role_configs: list[RoleConfig] = []
_cache_loaded_at: float | None = None


def get_role_configs(now: float | None = None) -> list[RoleConfig]:
    """Return the cached, active-only Role_Config list, refreshing from DynamoDB if stale.

    Refreshes from `roles.store.scan_role_config_items()` only when the TTL
    (`ROLE_CONFIG_CACHE_TTL_SECONDS`, default 30s) has elapsed since the
    last successful load. The returned list is filtered to entries whose
    `is_active` is True -- the Agent never offers an inactive (logically
    deleted) Role_Entry as a selection candidate, regardless of whether it
    otherwise satisfies the field requirements (Requirement 1.8).

    On a refresh failure (DynamoDB access denied, table missing, timeout,
    etc.), the previous cached value is kept and an error is logged. The
    "no valid Role_Entry" fallback to an empty list (Requirement 1.5) only
    applies when no successful load has ever occurred.

    Args:
        now: Optional override for the current monotonic time, used by
            tests to control TTL expiry deterministically. Defaults to
            `time.monotonic()`.

    Returns:
        The list of currently active, validated RoleConfig entries.
    """
    global _cached_role_configs, _cache_loaded_at
    current_time = now if now is not None else time.monotonic()

    with _cache_lock:
        is_stale = (
            _cache_loaded_at is None or (current_time - _cache_loaded_at) >= _cache_ttl_seconds()
        )
        if not is_stale:
            return _cached_role_configs

        try:
            raw_items = store.scan_role_config_items()
        except Exception as exc:  # noqa: BLE001 - any DynamoDB/network failure must fall back safely
            logger.error("roles.config.refresh_failed", extra={"error": str(exc)})
            if _cache_loaded_at is None:
                return []
            return _cached_role_configs

        role_configs = [rc for rc in _parse_items(raw_items) if rc.is_active]
        _cached_role_configs = role_configs
        _cache_loaded_at = current_time

        if not role_configs:
            logger.error(
                "roles.config.no_valid_entries",
                extra={"item_count": len(raw_items)},
            )
        else:
            logger.info(
                "roles.config.loaded",
                extra={"role_names": [rc.name for rc in role_configs]},
            )

        return role_configs


def get_role_by_name(name: str) -> RoleConfig | None:
    """Look up a role by its Role_Name among the currently active Role_Config entries.

    Args:
        name: The Role_Name to search for.

    Returns:
        The matching RoleConfig, or None if no currently active role has
        this name (including when `get_role_configs()` returns an empty
        list).
    """
    for role_config in get_role_configs():
        if role_config.name == name:
            return role_config
    return None
