"""Strands tool exposing the current date/time in Japan Standard Time (JST).

Thin wrapper around the pure formatters in `clock.format`, following the same
"pure helper + thin tool wrapper" split as `visualization/schema.py` +
`visualization/tool.py`. The model uses this instead of guessing today's date
or relying on training-time knowledge.

Uses a FIXED-offset timezone (`timezone(timedelta(hours=9))`) rather than
`zoneinfo.ZoneInfo("Asia/Tokyo")` so the container needs no `tzdata`
dependency. JST has no daylight saving time, so a constant +09:00 offset is
always correct.

This tool requires no AWS credentials, so it is intentionally NOT part of
`roles.hook.AWS_CREDENTIAL_TOOLS` and is not wrapped by
`RoleSelectingToolWrapper`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from strands import tool

from clock.format import format_jst, format_relative, jst_fields
from clock.parse import parse_to_utc

#: The tool name the agent invokes to read the current date/time.
CLOCK_TOOL_NAME = "get_current_datetime"

#: The name carried on the tool result's JSON content block.
CLOCK_EVENT_NAME = "current_datetime"

#: The tool name the agent invokes to convert a timestamp to JST.
CONVERT_TOOL_NAME = "convert_to_jst"

#: The name carried on the convert_to_jst result's JSON content block.
CONVERT_EVENT_NAME = "jst_conversion"

#: The tool name the agent invokes to get a relative-time phrase.
TIME_AGO_TOOL_NAME = "time_ago"

#: The name carried on the time_ago result's JSON content block.
TIME_AGO_EVENT_NAME = "relative_time"

#: Fixed Japan Standard Time offset (UTC+9, no DST). Avoids a tzdata dependency.
JST = timezone(timedelta(hours=9))

#: Guidance returned to the model when a timestamp cannot be parsed.
_PARSE_GUIDANCE = (
    "Could not parse the timestamp. Provide an ISO 8601 string (e.g. "
    "'2026-07-21T06:30:45Z' or '2026-07-21T15:30:45+09:00') or an epoch "
    "number (seconds, or milliseconds when the value is >= 1e12). You may "
    "also pass unit='s' or unit='ms' to disambiguate an epoch number."
)


@tool(name=CLOCK_TOOL_NAME)
def get_current_datetime() -> dict[str, Any]:
    """Get the current date and time in Japan Standard Time (JST, UTC+9).

    Call this tool whenever you need to know today's date or the current
    time -- for example to answer questions about "today", recent time
    windows, or to timestamp your reasoning. It returns the current wall-clock
    time in Japan Standard Time (JST, UTC+9) both as a human-readable Japanese
    string and as an ISO 8601 timestamp.

    Do NOT guess the current date/time and do NOT rely on training-time
    knowledge for it; always call this tool instead.

    This tool takes no parameters.

    Returns:
        A Strands ToolResult whose content carries the current JST datetime
        as structured JSON (under the "current_datetime" name) and as a
        human-readable text line.
    """
    now = datetime.now(JST)
    text = format_jst(now)
    return {
        "status": "success",
        "content": [
            {"json": {"name": CLOCK_EVENT_NAME, "value": jst_fields(now)}},
            {"text": text},
        ],
    }


@tool(name=CONVERT_TOOL_NAME)
def convert_to_jst(
    timestamp: str | float, unit: str | None = None
) -> dict[str, Any]:
    """Convert a UTC/ISO-8601/epoch timestamp to Japan Standard Time.

    Use this to show an AWS timestamp in Japan time. AWS resource timestamps
    (e.g. an EC2/S3 CreationDate, an S3 LastModified, a CloudWatch time) are
    in UTC, so this tool assumes a naive ISO string with no offset is UTC.

    Accepts either an ISO 8601 string (a trailing ``Z`` is treated as UTC) or
    an epoch number in seconds or milliseconds (values >= 1e12 are treated as
    milliseconds; pass ``unit`` = "s" or "ms" to override). The result is the
    same instant expressed in JST (UTC+9), returned as a human-readable
    Japanese string plus structured fields, and it echoes the source UTC ISO
    timestamp so you can confirm the conversion.

    Args:
        timestamp: An ISO 8601 string or epoch number (int/float or a numeric
            string) to convert.
        unit: Optional epoch unit, ``"s"`` or ``"ms"``, overriding the
            seconds-vs-milliseconds magnitude heuristic.

    Returns:
        A Strands ToolResult carrying the JST fields (plus the source UTC ISO)
        as JSON under the "jst_conversion" name and a human-readable text line.
        On parse failure, an error result asking for a valid timestamp.
    """
    try:
        utc = parse_to_utc(timestamp, unit)
    except ValueError:
        return {
            "status": "error",
            "content": [{"text": _PARSE_GUIDANCE}],
        }

    jst = utc.astimezone(JST)
    fields = jst_fields(jst)
    source_utc_iso = utc.isoformat(timespec="seconds")
    value = {**fields, "source_utc": source_utc_iso}
    return {
        "status": "success",
        "content": [
            {"json": {"name": CONVERT_EVENT_NAME, "value": value}},
            {"text": format_jst(jst)},
        ],
    }


@tool(name=TIME_AGO_TOOL_NAME)
def time_ago(
    timestamp: str | float, unit: str | None = None
) -> dict[str, Any]:
    """How long ago (or until) a UTC/ISO/epoch timestamp is, relative to now.

    Use this to describe an AWS timestamp in relative terms (e.g. "how long
    ago was this resource created"). AWS timestamps are UTC, so a naive ISO
    string with no offset is assumed to be UTC. Accepts an ISO 8601 string (a
    trailing ``Z`` is treated as UTC) or an epoch number in seconds or
    milliseconds (values >= 1e12 are milliseconds; pass ``unit`` = "s"/"ms"
    to override).

    The relative phrase is in Japanese and covers both past ("約N分前") and
    future ("約N分後") instants; the absolute time is also given in JST.

    Args:
        timestamp: An ISO 8601 string or epoch number (int/float or a numeric
            string).
        unit: Optional epoch unit, ``"s"`` or ``"ms"``.

    Returns:
        A Strands ToolResult carrying the relative phrase, source UTC ISO,
        JST ISO, and delta in seconds as JSON under the "relative_time" name,
        plus a human-readable text line. On parse failure, an error result
        asking for a valid timestamp.
    """
    try:
        utc = parse_to_utc(timestamp, unit)
    except ValueError:
        return {
            "status": "error",
            "content": [{"text": _PARSE_GUIDANCE}],
        }

    now = datetime.now(timezone.utc)
    delta_seconds = (now - utc).total_seconds()
    phrase = format_relative(delta_seconds)
    jst = utc.astimezone(JST)
    iso_jst = jst.isoformat(timespec="seconds")
    text = f"{phrase} ({format_jst(jst)})"
    value = {
        "relative": phrase,
        "iso_utc": utc.isoformat(timespec="seconds"),
        "iso_jst": iso_jst,
        "delta_seconds": delta_seconds,
    }
    return {
        "status": "success",
        "content": [
            {"json": {"name": TIME_AGO_EVENT_NAME, "value": value}},
            {"text": text},
        ],
    }
