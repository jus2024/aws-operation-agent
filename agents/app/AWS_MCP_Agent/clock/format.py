"""Pure JST datetime formatting helpers for the current-datetime tool.

Provides total, side-effect-free formatters that turn a timezone-aware
`datetime` (already expressed in Japan Standard Time) into a clear
human-readable Japanese string plus an ISO 8601 representation. Following
the Strands agent convention of splitting runtime logic into a pure helper
(`clock/format.py`) and a thin tool wrapper (`clock/tool.py`) -- mirroring
`visualization/schema.py` + `visualization/tool.py` -- these functions never
read the wall clock themselves; the caller passes the time in. That keeps
them deterministic and trivially testable offline.

JST has no daylight saving time, so a fixed UTC+9 offset is always correct
and no `zoneinfo`/`tzdata` dependency is needed.
"""

from __future__ import annotations

from datetime import datetime

#: 曜日ラベル。`datetime.weekday()` は月曜=0 ... 日曜=6 を返す。
_JP_WEEKDAYS: tuple[str, ...] = ("月", "火", "水", "木", "金", "土", "日")


def jst_fields(now: datetime) -> dict[str, str]:
    """Return the JST datetime broken into structured fields.

    Suitable for the tool's JSON content block. Non-zero-padded year/month/
    day; zero-padded hour/minute/second in the ``time`` field. The ``iso``
    field is a full ISO 8601 timestamp including the ``+09:00`` offset.

    Args:
        now: A timezone-aware datetime already expressed in JST (UTC+9).

    Returns:
        A dict with ``iso``, ``date``, ``time``, ``weekday``, ``timezone``
        and ``utc_offset`` keys.
    """
    weekday = _JP_WEEKDAYS[now.weekday()]
    return {
        "iso": now.isoformat(timespec="seconds"),
        "date": f"{now.year}年{now.month}月{now.day}日（{weekday}）",
        "time": now.strftime("%H:%M:%S"),
        "weekday": weekday,
        "timezone": "JST",
        "utc_offset": "+09:00",
    }


def format_relative(delta_seconds: float) -> str:
    """Format a signed time delta as a Japanese relative phrase.

    ``delta_seconds`` is the number of seconds between a reference instant
    and "now": a POSITIVE value means the instant is in the PAST (that many
    seconds ago), a NEGATIVE value means it is in the FUTURE. Past phrases end
    in ``前`` and future phrases mirror them with ``後``; the ``たった今``
    boundary (< 10s in either direction) has no suffix.

    Buckets (by absolute magnitude):
      - < 10s   -> ``たった今``
      - < 60s   -> ``約N秒前`` / ``約N秒後``
      - < 60m   -> ``約N分前`` / ``約N分後``
      - < 24h   -> ``約N時間前`` / ``約N時間後``
      - < 30d   -> ``N日前`` / ``N日後``
      - < 365d  -> ``約Nか月前`` / ``約Nか月後``
      - else    -> ``約N年前`` / ``約N年後``

    Pure and total: no wall-clock reads; the caller computes the delta.

    Args:
        delta_seconds: Signed seconds; positive = past, negative = future.

    Returns:
        A Japanese relative-time phrase.
    """
    seconds = abs(delta_seconds)

    if seconds < 10:
        return "たった今"

    suffix = "前" if delta_seconds >= 0 else "後"

    if seconds < 60:
        return f"約{int(seconds)}秒{suffix}"
    if seconds < 3600:
        return f"約{int(seconds // 60)}分{suffix}"
    if seconds < 86400:
        return f"約{int(seconds // 3600)}時間{suffix}"
    if seconds < 2592000:  # 30 days
        return f"{int(seconds // 86400)}日{suffix}"
    if seconds < 31536000:  # 365 days
        return f"約{int(seconds // 2592000)}か月{suffix}"
    return f"約{int(seconds // 31536000)}年{suffix}"


def format_jst(now: datetime) -> str:
    """Format a JST datetime as a human-readable string plus ISO 8601.

    Example output::

        2026年7月21日（火）15:30:45 JST (UTC+9) / ISO: 2026-07-21T15:30:45+09:00

    Non-zero-padded year/month/day; zero-padded hour/minute/second. Pure and
    total: no wall-clock reads, so the same input always yields the same
    output.

    Args:
        now: A timezone-aware datetime already expressed in JST (UTC+9).

    Returns:
        A single-line human-readable string that also embeds the ISO 8601
        timestamp with the ``+09:00`` offset.
    """
    fields = jst_fields(now)
    return (
        f"{fields['date']}{fields['time']} JST (UTC+9) / ISO: {fields['iso']}"
    )
