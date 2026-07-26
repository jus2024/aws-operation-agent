"""Human-readable unit formatting for the AWS MCP Agent.

Exposes a pure byte-count formatter (`units.humanize`) and the Strands tool
(`units.tool`) the agent calls to render byte sizes (e.g. an S3 object or
bucket size from AWS) as readable strings instead of raw integers. Follows
the same "pure helper module + thin tool wrapper" split used by the `clock`
and `visualization` packages.
"""

from units.humanize import humanize_bytes
from units.tool import HUMANIZE_BYTES_EVENT_NAME, HUMANIZE_BYTES_TOOL_NAME

__all__ = [
    "HUMANIZE_BYTES_EVENT_NAME",
    "HUMANIZE_BYTES_TOOL_NAME",
    "humanize_bytes",
]
