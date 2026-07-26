"""Unit tests for the get_current_datetime Strands tool (clock/tool.py).

The tool reads real wall-clock time, so we assert on stable substrings
(`JST`, `+09:00`, ISO shape) rather than a specific instant.
"""

from __future__ import annotations

import re

from clock.tool import (
    CLOCK_EVENT_NAME,
    CONVERT_EVENT_NAME,
    TIME_AGO_EVENT_NAME,
    convert_to_jst,
    get_current_datetime,
    time_ago,
)


def test_tool_returns_success_envelope() -> None:
    result = get_current_datetime()
    assert result["status"] == "success"
    content = result["content"]
    assert isinstance(content, list) and len(content) == 2


def test_tool_text_content_contains_jst_and_offset() -> None:
    result = get_current_datetime()
    text_blocks = [c["text"] for c in result["content"] if "text" in c]
    assert len(text_blocks) == 1
    text = text_blocks[0]
    assert "JST" in text
    assert "+09:00" in text
    # ISO 8601 timestamp with +09:00 offset somewhere in the line.
    assert re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00", text)


def test_tool_json_content_carries_jst_fields() -> None:
    result = get_current_datetime()
    json_blocks = [c["json"] for c in result["content"] if "json" in c]
    assert len(json_blocks) == 1
    block = json_blocks[0]
    assert block["name"] == CLOCK_EVENT_NAME
    value = block["value"]
    assert value["utc_offset"] == "+09:00"
    assert value["timezone"] == "JST"
    assert value["weekday"] in ("月", "火", "水", "木", "金", "土", "日")


def test_convert_to_jst_success_from_iso_z() -> None:
    result = convert_to_jst("2026-07-21T06:30:45Z")
    assert result["status"] == "success"
    json_blocks = [c["json"] for c in result["content"] if "json" in c]
    assert json_blocks[0]["name"] == CONVERT_EVENT_NAME
    value = json_blocks[0]["value"]
    # 06:30:45 UTC -> 15:30:45 JST.
    assert value["time"] == "15:30:45"
    assert value["utc_offset"] == "+09:00"
    assert value["source_utc"] == "2026-07-21T06:30:45+00:00"
    text = [c["text"] for c in result["content"] if "text" in c][0]
    assert "15:30:45" in text and "JST" in text


def test_convert_to_jst_success_from_epoch() -> None:
    result = convert_to_jst(1_700_000_000)
    assert result["status"] == "success"


def test_convert_to_jst_error_on_garbage() -> None:
    result = convert_to_jst("not-a-timestamp")
    assert result["status"] == "error"
    assert result["content"][0]["text"]


def test_time_ago_success_past() -> None:
    result = time_ago("2000-01-01T00:00:00Z")
    assert result["status"] == "success"
    value = [c["json"] for c in result["content"] if "json" in c][0]["value"]
    assert value["relative"].endswith("前")
    assert value["delta_seconds"] > 0
    assert "iso_utc" in value and "iso_jst" in value
    text = [c["text"] for c in result["content"] if "text" in c][0]
    assert "前" in text and "JST" in text


def test_time_ago_success_future() -> None:
    result = time_ago("2999-01-01T00:00:00Z")
    assert result["status"] == "success"
    value = [c["json"] for c in result["content"] if "json" in c][0]["value"]
    assert value["relative"].endswith("後")
    assert value["delta_seconds"] < 0


def test_time_ago_json_name() -> None:
    result = time_ago("2000-01-01T00:00:00Z")
    json_blocks = [c["json"] for c in result["content"] if "json" in c]
    assert json_blocks[0]["name"] == TIME_AGO_EVENT_NAME


def test_time_ago_error_on_garbage() -> None:
    result = time_ago("garbage")
    assert result["status"] == "error"
    assert result["content"][0]["text"]
