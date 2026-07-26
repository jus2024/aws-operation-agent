"""Current date/time (JST) support for the AWS MCP Agent.

Exposes pure helpers -- a JST formatter (`clock.format`) and a timestamp
parser (`clock.parse`) -- and the Strands tools (`clock.tool`) the agent
calls to read the current Japan Standard Time, convert AWS (UTC) timestamps
to JST, and describe them in relative terms, instead of guessing the date or
doing timezone math itself. See the module docstrings for the fixed UTC+9
(no tzdata) rationale.
"""

from clock.format import format_jst, format_relative, jst_fields
from clock.parse import parse_to_utc
from clock.tool import (
    CLOCK_EVENT_NAME,
    CLOCK_TOOL_NAME,
    CONVERT_EVENT_NAME,
    CONVERT_TOOL_NAME,
    JST,
    TIME_AGO_EVENT_NAME,
    TIME_AGO_TOOL_NAME,
    convert_to_jst,
    get_current_datetime,
    time_ago,
)

__all__ = [
    "CLOCK_EVENT_NAME",
    "CLOCK_TOOL_NAME",
    "CONVERT_EVENT_NAME",
    "CONVERT_TOOL_NAME",
    "JST",
    "TIME_AGO_EVENT_NAME",
    "TIME_AGO_TOOL_NAME",
    "convert_to_jst",
    "format_jst",
    "format_relative",
    "get_current_datetime",
    "jst_fields",
    "parse_to_utc",
    "time_ago",
]
