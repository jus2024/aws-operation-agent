"""Unit tests for the pure JST formatter (clock/format.py).

Deterministic, offline: `format_jst` / `jst_fields` never read the wall clock,
so we feed fixed timezone-aware datetimes and assert on the exact output.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from clock.format import format_jst, format_relative, jst_fields

JST = timezone(timedelta(hours=9))


def test_format_jst_known_date_and_weekday() -> None:
    # 2026-07-21 is a Tuesday -> 火.
    now = datetime(2026, 7, 21, 15, 30, 45, tzinfo=JST)
    text = format_jst(now)
    assert "2026年7月21日（火）" in text
    assert "15:30:45" in text
    assert "JST" in text
    assert "2026-07-21T15:30:45+09:00" in text


def test_format_jst_zero_pads_time_not_date() -> None:
    # Single-digit month/day/hour: date unpadded, time zero-padded.
    now = datetime(2026, 1, 5, 9, 3, 7, tzinfo=JST)
    text = format_jst(now)
    assert "2026年1月5日" in text
    assert "09:03:07" in text
    assert "+09:00" in text


def test_jst_fields_shape() -> None:
    now = datetime(2026, 7, 21, 15, 30, 45, tzinfo=JST)
    fields = jst_fields(now)
    assert fields["weekday"] == "火"
    assert fields["timezone"] == "JST"
    assert fields["utc_offset"] == "+09:00"
    assert fields["time"] == "15:30:45"
    assert fields["date"] == "2026年7月21日（火）"
    assert fields["iso"] == "2026-07-21T15:30:45+09:00"


def test_weekday_mapping_full_week() -> None:
    # 2026-07-20 (Mon) .. 2026-07-26 (Sun).
    expected = ["月", "火", "水", "木", "金", "土", "日"]
    for offset, wd in enumerate(expected):
        now = datetime(2026, 7, 20, 0, 0, 0, tzinfo=JST) + timedelta(days=offset)
        assert jst_fields(now)["weekday"] == wd


def test_format_relative_just_now() -> None:
    assert format_relative(0) == "たった今"
    assert format_relative(5) == "たった今"
    assert format_relative(-5) == "たった今"


def test_format_relative_seconds_past_and_future() -> None:
    assert format_relative(90 - 60) == "約30秒前"  # 30s -> seconds bucket
    assert format_relative(30) == "約30秒前"
    assert format_relative(-30) == "約30秒後"


def test_format_relative_minutes() -> None:
    assert format_relative(90) == "約1分前"
    assert format_relative(-90) == "約1分後"


def test_format_relative_hours() -> None:
    three_hours = 3600 * 3
    assert format_relative(three_hours) == "約3時間前"
    assert format_relative(-three_hours) == "約3時間後"


def test_format_relative_days() -> None:
    two_days = 86400 * 2
    assert format_relative(two_days) == "2日前"
    assert format_relative(-two_days) == "2日後"


def test_format_relative_months() -> None:
    forty_days = 86400 * 40
    assert format_relative(forty_days) == "約1か月前"
    assert format_relative(-forty_days) == "約1か月後"


def test_format_relative_years() -> None:
    four_hundred_days = 86400 * 400
    assert format_relative(four_hundred_days) == "約1年前"
    assert format_relative(-four_hundred_days) == "約1年後"
