"""System prompt generation with dynamic session context embedding.

Generates the system prompt for the AWS MCP Agent, dynamically embedding
a general description of the session's Role_Set and the available tool
categories. Unlike the earlier single-`operation_scope` model, a session
may now be configured with one or more AWS roles (a Role_Set). The prompt
instructs the agent on how to select among those roles -- via the
`role_name` parameter exposed on credential-requiring tools when more than
one role is configured (see roles/tool_schema.py) -- and on what each
possible operation scope permits, without describing any single fixed
scope for the whole session.

The prompt intentionally avoids embedding any concrete Role_ARN, AWS
account ID, or endpoint URL. Roles are described only in general terms
(a display name, an account label, and an operation scope) to minimize
exposure of sensitive/identifying information and reduce the prompt
injection surface.

This is a pure function module — no side effects.
"""

from __future__ import annotations


def build_system_prompt(
    available_tools: list[str] | None = None,
) -> str:
    """Generate a system prompt with session context.

    Embeds:
    - A general description of the Role_Set mechanism: a session may have
      one or more configured AWS roles, each identified only by a display
      name, an account label, and an operation scope, and instructions to
      pick the appropriate one via the `role_name` tool parameter when more
      than one role is configured.
    - A reference describing what each operation scope (readonly,
      readwrite, admin) permits, since the scope that actually applies to
      a given tool call depends on whichever role is selected for that
      call rather than on a single scope fixed for the whole session.
    - Available tool categories (if provided).

    Note: No concrete Role_ARN or AWS account identifier is embedded in
    the prompt (Requirement 8.3, carried over from direct-role-switching).
    The actual Role_Set for a session and the scope enforcement for each
    tool call are resolved dynamically per tool invocation (see
    roles/hook.py and roles/tool_schema.py), not baked into this static
    prompt text.

    Args:
        available_tools: Optional list of tool names/categories available
            in this session. If provided, general categories are listed
            in the prompt.

    Returns:
        A formatted system prompt string.
    """
    scope_reference = _build_scope_reference()
    tools_section = _build_tools_section(available_tools)

    return (
        "You are an AWS operations assistant. You help users manage and "
        "query their AWS infrastructure using the tools available in your "
        "current connection.\n"
        "\n"
        "This session may be configured with one or more AWS roles (a "
        "Role_Set). Each role is described only by a display name, a "
        "general account label, and an operation scope (readonly, "
        "readwrite, or admin) -- no underlying Role_ARN or AWS account ID "
        "is disclosed to you.\n"
        "\n"
        "When you call a tool that requires AWS credentials (such as "
        "call_aws, run_script, get_presigned_url, or get_tasks) and more "
        "than one role is configured for this session, that tool's input "
        "schema will expose a required `role_name` parameter listing the "
        "available role names. You MUST choose the role_name whose "
        "account and permission level match the operation the user is "
        "requesting. If only one role is configured for this session, no "
        "such parameter is exposed and that sole role is used "
        "automatically.\n"
        "\n"
        "IMPORTANT: When multiple roles are configured, omitting `role_name` "
        "on a credential-requiring tool call is NOT optional and will always "
        "fail immediately (the call is rejected before it ever reaches AWS). "
        "Before every such tool call, explicitly check: 'are 2+ roles "
        "configured in this session, and if so, did I include role_name?' "
        "When a user asks you to check the same thing across multiple "
        "accounts/roles, call the tool once per role_name, one at a time -- "
        "never assume a single call without role_name covers all of them.\n"
        "\n"
        "IMPORTANT: `run_script` is ALWAYS classified as a write operation "
        "by this system, regardless of what the script code inside it does "
        "-- even a script that only reads data (e.g. calling GetCostAndUsage) "
        "is rejected in a readonly-scoped role. If `run_script` is rejected "
        "in a readonly session, do NOT retry it (not with a different "
        "role_name, not with a rewritten script) -- switch to `call_aws` "
        "instead, which IS usable for read operations in a readonly role. "
        "After ANY tool rejection (scope, role_name, or otherwise), read "
        "the rejection message and change your approach on the very next "
        "call -- never repeat the exact same failing call.\n"
        "\n"
        "When you need the current date or time (for example to answer "
        "questions about 'today', recent time windows, or to timestamp your "
        "reasoning), call the `get_current_datetime` tool. It returns the "
        "current Japan Standard Time (JST, UTC+9). Do NOT guess the current "
        "date/time or rely on training-time knowledge.\n"
        "\n"
        "AWS timestamps are in UTC -- use `convert_to_jst` to show them in "
        "Japan time and `time_ago` for relative time. Use `humanize_bytes` "
        "to format byte sizes (e.g. S3 sizes), and `calculate` for "
        "arithmetic instead of computing it yourself.\n"
        "\n"
        "You have access to the AWS MCP tools provided by this session's "
        "connection. Select tools whose descriptions match the user's "
        "intent and invoke them accordingly.\n"
        "Do NOT fabricate tool names or invoke tools that are not available "
        "in your current session.\n"
        "If no available tool matches the user's request, respond indicating "
        "that the requested operation is not supported and list the "
        "categories of available tools.\n"
        "\n"
        f"{scope_reference}\n"
        f"{tools_section}"
    )


def _build_scope_reference() -> str:
    """Build a reference describing what each possible operation scope permits.

    Scope enforcement is performed per tool call based on whichever role
    was selected for that specific call (see roles/hook.py), not on a
    single scope fixed for the whole session. This reference therefore
    describes all three possible operation scopes generically, so the
    agent understands the restrictions that may apply regardless of which
    configured role ends up being selected for a given call.

    Returns:
        A formatted scope reference string.
    """
    lines = [
        "Operation scope reference (the scope that actually applies to a "
        "given tool call is determined by whichever role was selected for "
        "that call, and is enforced by the system -- not by this text):"
    ]
    for scope in ("readonly", "readwrite", "admin"):
        lines.append(_build_scope_instruction(scope))
    return "\n".join(lines)


def _build_scope_instruction(operation_scope: str) -> str:
    """Build scope-specific instructions for the system prompt.

    Args:
        operation_scope: The operation scope for the session.

    Returns:
        Scope constraint instructions as a string.
    """
    normalized = operation_scope.strip().lower() if operation_scope else "readonly"

    if normalized == "readonly":
        return (
            "SCOPE RESTRICTION: This session is READ-ONLY.\n"
            "You MUST NOT perform any write operations (create, update, "
            "delete, modify, start, stop, terminate, or any action that "
            "changes AWS resource state).\n"
            "If the user requests a write operation, inform them that the "
            "current session is read-only and suggest starting a new session "
            "with 'readwrite' scope."
        )
    elif normalized == "readwrite":
        return (
            "SCOPE: This session permits both read and write operations.\n"
            "You may perform create, update, delete, and other mutating "
            "operations when requested by the user. Exercise caution with "
            "destructive actions and confirm with the user before proceeding."
        )
    elif normalized == "admin":
        return (
            "SCOPE: This session has administrative permissions.\n"
            "You may perform all operations including administrative actions. "
            "Exercise extra caution with destructive or irreversible actions "
            "and confirm with the user before proceeding."
        )
    else:
        # Unknown scope — default to readonly behavior (fail-safe)
        return (
            "SCOPE RESTRICTION: This session is READ-ONLY (default).\n"
            "You MUST NOT perform any write operations. If the user requests "
            "a write operation, inform them that the current session is "
            "read-only and suggest starting a new session with 'readwrite' "
            "scope."
        )


def _build_tools_section(available_tools: list[str] | None) -> str:
    """Build the available tools section of the system prompt.

    Args:
        available_tools: Optional list of tool names available in this session.

    Returns:
        A formatted tools section string, or empty string if no tools provided.
    """
    if not available_tools:
        return ""

    categories = _categorize_tools(available_tools)

    if not categories:
        return ""

    lines = ["Available tool categories for this connection:"]
    for category in sorted(categories):
        lines.append(f"  - {category}")

    return "\n".join(lines) + "\n"


def _categorize_tools(tool_names: list[str]) -> set[str]:
    """Extract general categories from tool names.

    Categorizes tools by matching keywords in the tool name against
    known AWS service patterns.

    Args:
        tool_names: List of tool names from the connected Gateway.

    Returns:
        A set of inferred category names.
    """
    categories: set[str] = set()

    for name in tool_names:
        category = _infer_category(name)
        if category:
            categories.add(category)

    return categories


# Mapping of keyword fragments in tool names to service categories
_SERVICE_KEYWORDS: dict[str, str] = {
    "bucket": "S3 (Storage)",
    "object": "S3 (Storage)",
    "instance": "EC2 (Compute)",
    "vpc": "VPC (Networking)",
    "subnet": "VPC (Networking)",
    "security_group": "VPC (Networking)",
    "securitygroup": "VPC (Networking)",
    "lambda": "Lambda (Serverless)",
    "function": "Lambda (Serverless)",
    "dynamodb": "DynamoDB (Database)",
    "table": "DynamoDB (Database)",
    "rds": "RDS (Database)",
    "iam": "IAM (Identity)",
    "role": "IAM (Identity)",
    "policy": "IAM (Identity)",
    "cloudformation": "CloudFormation (IaC)",
    "stack": "CloudFormation (IaC)",
    "cloudwatch": "CloudWatch (Monitoring)",
    "log": "CloudWatch (Monitoring)",
    "alarm": "CloudWatch (Monitoring)",
    "ecs": "ECS (Containers)",
    "eks": "EKS (Kubernetes)",
    "sns": "SNS (Messaging)",
    "sqs": "SQS (Messaging)",
    "s3": "S3 (Storage)",
    "ec2": "EC2 (Compute)",
}


def _infer_category(tool_name: str) -> str:
    """Infer the AWS service category from a tool name.

    Args:
        tool_name: The tool name from the Gateway.

    Returns:
        The inferred category name, or empty string if not recognized.
    """
    lowered = tool_name.lower()

    for keyword, category in _SERVICE_KEYWORDS.items():
        if keyword in lowered:
            return category

    return ""
