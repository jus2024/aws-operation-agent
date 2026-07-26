"""Strands tool exposing the pure byte-count formatter.

Thin wrapper around :func:`units.humanize.humanize_bytes`, following the same
"pure helper + thin tool wrapper" split as `clock/format.py` + `clock/tool.py`
and `visualization/schema.py` + `visualization/tool.py`. The model uses this
to render byte sizes (e.g. an S3 object/bucket size from AWS) rather than
doing the unit math itself.

This tool requires no AWS credentials, so it is intentionally NOT part of
`roles.hook.AWS_CREDENTIAL_TOOLS` and is not wrapped by
`RoleSelectingToolWrapper`.
"""

from __future__ import annotations

from typing import Any

from strands import tool

from units.humanize import humanize_bytes as _humanize_bytes

#: The tool name the agent invokes to format a byte count.
HUMANIZE_BYTES_TOOL_NAME = "humanize_bytes"

#: The name carried on the tool result's JSON content block.
HUMANIZE_BYTES_EVENT_NAME = "humanized_bytes"


@tool(name=HUMANIZE_BYTES_TOOL_NAME)
def humanize_bytes(num_bytes: float, binary: bool = True) -> dict[str, Any]:
    """Format a byte count (e.g. an S3 object/bucket size from AWS) as a human-readable string.

    Use this to turn a raw byte count into a readable size like ``1.5 KiB``
    instead of doing the unit math yourself. By default uses binary IEC units
    (KiB/MiB/GiB..., base 1024); pass ``binary`` = False for decimal SI units
    (KB/MB/GB..., base 1000).

    Args:
        num_bytes: The byte count to format. Must be finite and non-negative.
        binary: True for base-1024 IEC units (default), False for base-1000
            SI units.

    Returns:
        A Strands ToolResult carrying the input byte count, the formatted
        string, its unit suffix, and the binary flag as JSON under the
        "humanized_bytes" name, plus a human-readable text line. On invalid
        input, an error result explaining the constraint.
    """
    try:
        formatted = _humanize_bytes(num_bytes, binary)
    except ValueError as exc:
        return {
            "status": "error",
            "content": [
                {
                    "text": (
                        f"Cannot format {num_bytes!r} as a size: {exc}. Provide "
                        "a finite, non-negative number of bytes."
                    )
                }
            ],
        }

    unit = formatted.split(" ", 1)[1]
    value = {
        "input_bytes": num_bytes,
        "formatted": formatted,
        "unit": unit,
        "binary": binary,
    }
    return {
        "status": "success",
        "content": [
            {"json": {"name": HUMANIZE_BYTES_EVENT_NAME, "value": value}},
            {"text": formatted},
        ],
    }
