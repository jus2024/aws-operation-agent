"""boto3 DynamoDB access for the RoleConfig table.

Isolates the raw AWS SDK call from `roles/config.py`'s caching and
validation logic, mirroring the existing separation between `roles/sts.py`
(STS calls) and `roles/hook.py` (hook logic).

This module is intentionally a thin wrapper with no domain logic of its
own: it only knows how to Scan the table named by the
``ROLE_CONFIG_TABLE_NAME`` environment variable and page through the full
result set via ``LastEvaluatedKey``. Field validation, uniqueness
enforcement, TTL caching, and the "no valid Role_Entry" fallback all live in
`roles/config.py` (Requirement 1.5).
"""

from __future__ import annotations

import os

import boto3

ENV_VAR_ROLE_CONFIG_TABLE_NAME = "ROLE_CONFIG_TABLE_NAME"

_dynamodb_resource = boto3.resource("dynamodb")


def scan_role_config_items() -> list[dict]:
    """Scan the RoleConfig DynamoDB table and return every raw item.

    Pages through the full table via ``LastEvaluatedKey`` so that callers
    always receive the complete item set regardless of table size.

    Returns:
        A list of raw DynamoDB items (as plain ``dict`` objects) exactly as
        returned by boto3's DynamoDB resource ``Scan`` operation. No field
        validation or filtering is applied here -- that is the
        responsibility of `roles/config.py`.

    Raises:
        RuntimeError: If the ``ROLE_CONFIG_TABLE_NAME`` environment
            variable is unset or empty.
        botocore.exceptions.ClientError: Propagated unchanged if the DynamoDB
            Scan call fails (e.g. AccessDenied, ResourceNotFoundException).
        botocore.exceptions.BotoCoreError: Propagated unchanged for
            lower-level/network failures.
    """
    table_name = os.environ.get(ENV_VAR_ROLE_CONFIG_TABLE_NAME, "").strip()
    if not table_name:
        raise RuntimeError(f"{ENV_VAR_ROLE_CONFIG_TABLE_NAME} is not set")

    table = _dynamodb_resource.Table(table_name)
    items: list[dict] = []
    response = table.scan()
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        items.extend(response.get("Items", []))
    return items
