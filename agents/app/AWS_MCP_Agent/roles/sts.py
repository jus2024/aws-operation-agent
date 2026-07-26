"""boto3 STS AssumeRole helper.

Extracted as a standalone, dependency-light module so it can be shared by
both `roles/hook.py` (which decides *whether* a tool call needs credentials
and derives which Role_Name to use) and `gateway/manager.py` (which decides
*when* the mcp-proxy-for-aws subprocess needs to be restarted with fresh
credentials) without creating an import cycle between those two modules.

Per-call AssumeRole, no caching (Requirement 2.3, 2.5): this function makes
a fresh STS call every time it is invoked. Callers are responsible for their
own caching/reuse policy (see gateway/manager.py, which only calls this when
the requested Role_Name differs from the one its subprocess is currently
running as).
"""

from __future__ import annotations

import boto3

_ASSUME_ROLE_DURATION_SECONDS = 900
"""15 minutes -- the minimum DurationSeconds accepted by STS AssumeRole."""


def assume_role(role_arn: str, role_name: str) -> dict:
    """Call boto3 STS AssumeRole and return the resulting Credentials dict.

    Args:
        role_arn: The IAM Role_ARN to assume.
        role_name: The current session's Role_Name, used to build a
            distinguishable RoleSessionName for auditing.

    Returns:
        The `Credentials` dict from the STS AssumeRole response, containing
        `AccessKeyId`, `SecretAccessKey`, and `SessionToken`.

    Raises:
        ClientError: If STS rejects the AssumeRole call (e.g. AccessDenied).
        BotoCoreError: For lower-level/network failures.
    """
    sts_client = boto3.client("sts")
    response = sts_client.assume_role(
        RoleArn=role_arn,
        RoleSessionName=f"mcp-agent-{role_name}",
        DurationSeconds=_ASSUME_ROLE_DURATION_SECONDS,
    )
    return response["Credentials"]
