"""Visualization emission for the AWS MCP Agent (AG-UI Generative UI).

Exposes the shared Visualization_Schema helpers and the Strands tool the agent
calls to emit a Visualization_Payload over AG-UI (Req 1.3, 8.4).
"""

from visualization.schema import (
    SUPPORTED_VISUALIZATION_TYPES,
    VISUALIZATION_EVENT_NAME,
    build_visualization_event,
    is_valid_visualization,
    normalize_visualization,
)
from visualization.tool import VISUALIZATION_TOOL_NAME, emit_visualization

__all__ = [
    "SUPPORTED_VISUALIZATION_TYPES",
    "VISUALIZATION_EVENT_NAME",
    "VISUALIZATION_TOOL_NAME",
    "build_visualization_event",
    "emit_visualization",
    "is_valid_visualization",
    "normalize_visualization",
]
