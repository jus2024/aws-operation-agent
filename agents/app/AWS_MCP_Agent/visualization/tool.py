"""Strands tool that emits a Visualization_Payload over the AG-UI protocol.

Mirrors the `ag_ui_strands.a2ui_tool` "tool result envelope" pattern: the
Strands `Agent` produces content intended for visualization by *calling* this
tool, and the tool's result -- a JSON envelope conforming to the shared
Visualization_Schema -- is streamed to the frontend over AG-UI as a
`TOOL_CALL_RESULT`. The frontend runs that envelope through
`parseVisualization()` and renders the corresponding chart/table.

This keeps all visualization-producing runtime logic inside `agents/`; the
Web app (`src/`) never generates Visualization_Payload data (Req 8.4).

The tool validates and normalizes the payload with the pure helpers in
`visualization.schema`, so a malformed payload surfaces as a tool error the
model can self-correct rather than a broken frontend render.

Requirements: 1.3, 8.4
"""

from __future__ import annotations

import json
from typing import Any

from strands import tool

from visualization.schema import (
    SUPPORTED_VISUALIZATION_TYPES,
    VISUALIZATION_EVENT_NAME,
    is_valid_visualization,
    normalize_visualization,
)

#: The tool name the agent invokes to emit a visualization.
VISUALIZATION_TOOL_NAME = "emit_visualization"


@tool(name=VISUALIZATION_TOOL_NAME)
def emit_visualization(payload: dict[str, Any]) -> dict[str, Any]:
    """Emit a chart or table for the frontend to render as Generative UI.

    Call this when a quantitative answer is better shown as a bar chart, line
    chart, pie chart, or data table than as plain text. The payload MUST match
    the shared Visualization_Schema:

      - type: one of "bar", "line", "pie", "table".
      - title: a short human-readable string describing the visualization.
      - series: required for "bar"/"pie"/"line".
          * bar/pie: a list of {"label": str, "value": number} objects.
          * line: a list of {"name": str, "points": [{"x": str|number,
            "y": number}, ...]} objects.
          * table: pass an empty list [] (table data lives in columns/rows).
      - columns: required for "table" only — a list of column-header strings.
      - rows: required for "table" only — a list of rows, where each row is a
        list of cells (string or number) whose length equals len(columns).

    All numbers must be finite. Do not include fields that do not apply to the
    chosen type.

    Args:
        payload: The Visualization_Payload to render.

    Returns:
        A Strands ToolResult whose content carries the normalized
        Visualization_Payload as JSON under the "visualization" name, streamed
        to the frontend over AG-UI.
    """
    if not is_valid_visualization(payload):
        return {
            "status": "error",
            "content": [
                {
                    "text": (
                        "Invalid Visualization_Payload: it does not conform to "
                        "the Visualization_Schema. 'type' must be one of "
                        f"{list(SUPPORTED_VISUALIZATION_TYPES)}, 'title' must be "
                        "a string, and the series/columns/rows must match the "
                        "chosen type. Fix the payload and try again."
                    )
                }
            ],
        }

    normalized = normalize_visualization(payload)
    return {
        "status": "success",
        "content": [
            {
                "json": {
                    "name": VISUALIZATION_EVENT_NAME,
                    "value": normalized,
                }
            },
            {"text": json.dumps(normalized, ensure_ascii=False)},
        ],
    }
