"""Pure byte-count formatting helper.

Turns a raw byte count (e.g. an S3 object/bucket size returned by AWS) into a
compact human-readable string. Side-effect-free and deterministic, following
the "pure helper + thin tool wrapper" convention used across this agent
(mirrors `clock/format.py` + `clock/tool.py`).
"""

from __future__ import annotations

import math

#: Binary (IEC) unit suffixes, base 1024.
_BINARY_UNITS: tuple[str, ...] = ("B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB")

#: Decimal (SI) unit suffixes, base 1000.
_DECIMAL_UNITS: tuple[str, ...] = ("B", "KB", "MB", "GB", "TB", "PB", "EB")


def humanize_bytes(n: float, binary: bool = True) -> str:
    """Format a byte count as a human-readable string.

    By default uses binary IEC units (B, KiB, MiB, GiB, TiB, PiB, EiB) with a
    base of 1024. When ``binary`` is False, uses decimal SI units (B, KB, MB,
    GB, TB, PB, EB) with a base of 1000. The numeric part is rendered with up
    to two decimal places, trailing zeros trimmed, so ``1536`` becomes
    ``"1.5 KiB"`` and ``0`` becomes ``"0 B"``.

    Args:
        n: The byte count. Must be a finite, non-negative number.
        binary: True for base-1024 IEC units (default), False for base-1000
            SI units.

    Returns:
        A human-readable string such as ``"1.5 KiB"`` or ``"0 B"``.

    Raises:
        ValueError: If ``n`` is negative or not finite (NaN/inf).
    """
    if isinstance(n, bool) or not isinstance(n, (int, float)):
        raise ValueError(f"byte count must be a number, got {n!r}")
    if not math.isfinite(n):
        raise ValueError(f"byte count must be finite, got {n!r}")
    if n < 0:
        raise ValueError(f"byte count must be non-negative, got {n!r}")

    base = 1024.0 if binary else 1000.0
    units = _BINARY_UNITS if binary else _DECIMAL_UNITS

    value = float(n)
    index = 0
    while value >= base and index < len(units) - 1:
        value /= base
        index += 1

    return f"{_format_number(value)} {units[index]}"


def _format_number(value: float) -> str:
    """Render a float with up to 2 decimals, trailing zeros trimmed."""
    text = f"{value:.2f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text
