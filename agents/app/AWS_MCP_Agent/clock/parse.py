"""Pure timestamp parsing helper for the clock tools.

Turns an ISO 8601 string or an epoch number (seconds or milliseconds) into a
timezone-aware UTC `datetime`. AWS resource timestamps (e.g. a CreationDate,
a CloudWatch time, an S3 LastModified) are UTC, so a naive ISO string with no
offset is assumed to be UTC here.

Following the Strands agent convention of splitting runtime logic into a pure
helper module plus a thin tool wrapper (mirroring `clock/format.py` +
`clock/tool.py` and `visualization/schema.py` + `visualization/tool.py`),
this function reads no wall clock and has no side effects, so it is
deterministic and trivially testable offline. It never uses
`zoneinfo`/`tzdata`; UTC is a fixed zero offset.
"""

from __future__ import annotations

from datetime import UTC, datetime

#: Epoch values with an absolute magnitude at or above this threshold are
#: treated as milliseconds; smaller ones as seconds. 1e12 seconds is far in
#: the future (year 33658), while 1e12 milliseconds is ~2001, so this cleanly
#: separates plausible second- and millisecond-scale timestamps.
_MS_THRESHOLD = 1e12


def parse_to_utc(value: object, unit: str | None = None) -> datetime:
    """Parse an ISO 8601 string or epoch number into an aware UTC datetime.

    Accepts:
      - ISO 8601 strings via :func:`datetime.fromisoformat`. A trailing ``Z``
        is treated as ``+00:00``. If the parsed datetime is NAIVE (carries no
        tzinfo), it is assumed to be UTC (AWS timestamps are UTC) and UTC is
        attached.
      - Epoch numbers: ``int`` or ``float``, or a numeric string. The
        seconds-vs-milliseconds heuristic treats values whose absolute
        magnitude is >= 1e12 as milliseconds, otherwise seconds. Pass an
        explicit ``unit`` of ``"s"`` or ``"ms"`` to override the heuristic.

    Args:
        value: The timestamp to parse (str, int, or float).
        unit: Optional explicit epoch unit, ``"s"`` or ``"ms"``. When given,
            it overrides the magnitude heuristic for numeric input. Ignored
            for non-numeric ISO strings.

    Returns:
        A timezone-aware :class:`datetime` in UTC.

    Raises:
        ValueError: If the value cannot be parsed as an ISO 8601 timestamp or
            an epoch number, or if ``unit`` is not one of ``"s"``/``"ms"``.
    """
    if unit is not None and unit not in ("s", "ms"):
        raise ValueError(f"unit must be 's' or 'ms', got {unit!r}")

    # bool is an int subclass but is never a valid timestamp.
    if isinstance(value, bool):
        raise ValueError(f"Cannot parse {value!r} as a timestamp")

    if isinstance(value, (int, float)):
        return _epoch_to_utc(float(value), unit)

    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            raise ValueError("Cannot parse an empty string as a timestamp")
        # Prefer a numeric interpretation (epoch) when the string is a bare
        # number, otherwise fall back to ISO 8601 parsing.
        number = _try_parse_number(stripped)
        if number is not None:
            return _epoch_to_utc(number, unit)
        return _iso_to_utc(stripped)

    raise ValueError(f"Cannot parse {value!r} as a timestamp")


def _try_parse_number(text: str) -> float | None:
    """Return the float value of a bare numeric string, or None otherwise."""
    try:
        return float(text)
    except ValueError:
        return None


def _epoch_to_utc(epoch: float, unit: str | None) -> datetime:
    """Convert an epoch value to an aware UTC datetime.

    Args:
        epoch: The epoch value as a float.
        unit: Explicit ``"s"``/``"ms"`` unit, or None to use the magnitude
            heuristic.

    Raises:
        ValueError: If the epoch value is not finite or out of range.
    """
    if epoch != epoch or epoch in (float("inf"), float("-inf")):
        raise ValueError(f"Epoch value must be finite, got {epoch!r}")

    if unit == "ms":
        seconds = epoch / 1000.0
    elif unit == "s":
        seconds = epoch
    elif abs(epoch) >= _MS_THRESHOLD:
        seconds = epoch / 1000.0
    else:
        seconds = epoch

    try:
        return datetime.fromtimestamp(seconds, tz=UTC)
    except (OverflowError, OSError, ValueError) as exc:
        raise ValueError(f"Epoch value {epoch!r} is out of range") from exc


def _iso_to_utc(text: str) -> datetime:
    """Parse an ISO 8601 string into an aware UTC datetime.

    A trailing ``Z`` is treated as ``+00:00``. A naive result (no tzinfo) is
    assumed to be UTC.

    Raises:
        ValueError: If the string is not valid ISO 8601.
    """
    normalized = text
    if normalized.endswith(("Z", "z")):
        normalized = normalized[:-1] + "+00:00"

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(
            f"Cannot parse {text!r} as ISO 8601 or an epoch number"
        ) from exc

    if parsed.tzinfo is None:
        # Naive timestamp: AWS timestamps are UTC, so assume UTC.
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)
