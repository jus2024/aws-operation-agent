"""Unit tests for the pure byte formatter (units/humanize.py) and tool.

Deterministic and offline: `humanize_bytes` has no side effects.
"""

from __future__ import annotations

import math

import pytest

from units.humanize import humanize_bytes
from units.tool import HUMANIZE_BYTES_EVENT_NAME
from units.tool import humanize_bytes as humanize_bytes_tool


def test_zero() -> None:
    assert humanize_bytes(0) == "0 B"


def test_small_bytes_no_suffix_scaling() -> None:
    assert humanize_bytes(512) == "512 B"


def test_binary_kib_trims_trailing_zeros() -> None:
    assert humanize_bytes(1536) == "1.5 KiB"


def test_binary_exact_kib() -> None:
    assert humanize_bytes(1024) == "1 KiB"


def test_decimal_mode_kb() -> None:
    assert humanize_bytes(1000, binary=False) == "1 KB"
    assert humanize_bytes(1500, binary=False) == "1.5 KB"


def test_large_binary_units() -> None:
    assert humanize_bytes(1024**4) == "1 TiB"
    assert humanize_bytes(1024**5) == "1 PiB"


def test_two_decimal_places_max() -> None:
    # 1234567 bytes -> 1.18 MiB (rounded to 2 dp).
    assert humanize_bytes(1_234_567) == "1.18 MiB"


@pytest.mark.parametrize("bad", [-1, -1024, float("nan"), math.inf, -math.inf])
def test_invalid_raises_value_error(bad: float) -> None:
    with pytest.raises(ValueError):
        humanize_bytes(bad)


def test_tool_success_shape() -> None:
    result = humanize_bytes_tool(1536)
    assert result["status"] == "success"
    json_block = [c["json"] for c in result["content"] if "json" in c][0]
    assert json_block["name"] == HUMANIZE_BYTES_EVENT_NAME
    value = json_block["value"]
    assert value["formatted"] == "1.5 KiB"
    assert value["unit"] == "KiB"
    assert value["input_bytes"] == 1536
    assert value["binary"] is True
    text = [c["text"] for c in result["content"] if "text" in c][0]
    assert text == "1.5 KiB"


def test_tool_decimal_mode() -> None:
    result = humanize_bytes_tool(1000, binary=False)
    assert result["status"] == "success"
    value = [c["json"] for c in result["content"] if "json" in c][0]["value"]
    assert value["formatted"] == "1 KB"
    assert value["binary"] is False


def test_tool_error_on_negative() -> None:
    result = humanize_bytes_tool(-5)
    assert result["status"] == "error"
    assert result["content"][0]["text"]
