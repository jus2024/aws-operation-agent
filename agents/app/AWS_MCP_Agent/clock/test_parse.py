"""Unit tests for the pure timestamp parser (clock/parse.py).

Deterministic, offline: `parse_to_utc` reads no wall clock, so we feed fixed
strings/numbers and assert on the exact aware-UTC result.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from clock.parse import parse_to_utc


def test_iso_with_z_is_utc() -> None:
    result = parse_to_utc("2026-07-21T06:30:45Z")
    assert result == datetime(2026, 7, 21, 6, 30, 45, tzinfo=UTC)
    assert result.tzinfo is UTC


def test_iso_with_offset_converted_to_utc() -> None:
    # 15:30:45 +09:00 == 06:30:45 UTC.
    result = parse_to_utc("2026-07-21T15:30:45+09:00")
    assert result == datetime(2026, 7, 21, 6, 30, 45, tzinfo=UTC)


def test_naive_iso_assumed_utc() -> None:
    result = parse_to_utc("2026-07-21T06:30:45")
    assert result == datetime(2026, 7, 21, 6, 30, 45, tzinfo=UTC)
    assert result.tzinfo is not None


def test_epoch_seconds() -> None:
    # 1_700_000_000 s -> 2023-11-14T22:13:20 UTC.
    result = parse_to_utc(1_700_000_000)
    assert result == datetime(2023, 11, 14, 22, 13, 20, tzinfo=UTC)


def test_epoch_milliseconds_by_heuristic() -> None:
    # >= 1e12 -> milliseconds. 1_700_000_000_000 ms == 1_700_000_000 s.
    result = parse_to_utc(1_700_000_000_000)
    assert result == datetime(2023, 11, 14, 22, 13, 20, tzinfo=UTC)


def test_numeric_string_epoch() -> None:
    result = parse_to_utc("1700000000")
    assert result == datetime(2023, 11, 14, 22, 13, 20, tzinfo=UTC)


def test_explicit_unit_ms_overrides_heuristic() -> None:
    # Small value that the heuristic would treat as seconds, forced to ms.
    # 1_700_000_000 ms == 1_700_000 s == 1970-01-20T16:13:20 UTC.
    result = parse_to_utc(1_700_000_000, unit="ms")
    assert result == datetime(1970, 1, 20, 16, 13, 20, tzinfo=UTC)


def test_explicit_unit_s_overrides_heuristic() -> None:
    # A value >= 1e12 that the heuristic would treat as ms. Forced to seconds
    # it must NOT be divided by 1000: seconds interpretation is far in the
    # future (beyond datetime's year 9999), so it raises rather than silently
    # producing the ms result.
    forced_ms = parse_to_utc(1_700_000_000_000, unit="ms")
    assert forced_ms == datetime(2023, 11, 14, 22, 13, 20, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_to_utc(1_700_000_000_000, unit="s")


def test_float_epoch_seconds() -> None:
    result = parse_to_utc(1_700_000_000.0)
    assert result == datetime(2023, 11, 14, 22, 13, 20, tzinfo=UTC)


@pytest.mark.parametrize(
    "bad",
    ["not-a-date", "", "   ", "2026-13-99T99:99:99", None, [], {}, True],
)
def test_invalid_raises_value_error(bad: object) -> None:
    with pytest.raises(ValueError):
        parse_to_utc(bad)


def test_invalid_unit_raises() -> None:
    with pytest.raises(ValueError):
        parse_to_utc(123, unit="minutes")
