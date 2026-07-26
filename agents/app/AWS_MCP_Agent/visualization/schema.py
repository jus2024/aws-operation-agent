"""Visualization_Schema — Agent 側の可視化ペイロード検証 / 正規化 / AG-UI 送出。

フロントエンド（`src/lib/agent/visualization/schema.ts`）と **合意された同一構造** の
`Visualization_Payload` を、Agent 側でも検証・正規化できるようにする純粋モジュール。
`prompts.system` / `roles.*` と同じく「ランタイムロジックを純粋関数へ切り出す」
Strands エージェント方針（設定・プロンプト・ツール・ランタイムの分離）に従う。

対応する可視化タイプは bar / line / pie / table の 4 種で、フロントの
`SUPPORTED_VISUALIZATION_TYPES` と一致させる。`is_valid_visualization` は
`schema.ts` の `isValidVisualization`、`normalize_visualization` は
`normalizeVisualization` を Python へ移植したもので、round-trip（正規化後も再検証を
満たす）等の性質を共有する。

送出は AG-UI プロトコルの `CustomEvent`（`name = VISUALIZATION_EVENT_NAME`、
`value = 正規化済みペイロード`）として行う。フロントはこの value を
`parseVisualization()` に通して描画する。可視化データを生成するランタイムロジックは
`agents/` 側に閉じ、Web アプリ本体（`src/`）には持ち込まない。

Requirements: 1.3, 8.4
"""

from __future__ import annotations

import math
from typing import Any

from ag_ui.core import CustomEvent

#: 対応する可視化タイプ（フロント `SUPPORTED_VISUALIZATION_TYPES` と一致）。
SUPPORTED_VISUALIZATION_TYPES: tuple[str, ...] = ("bar", "line", "pie", "table")

#: 可視化ペイロードを載せる AG-UI CustomEvent の name。フロントはこの名前の
#: CustomEvent の value を `parseVisualization()` に通して描画する。
VISUALIZATION_EVENT_NAME = "visualization"


def _is_plain_object(x: Any) -> bool:
    """dict（プレーンなオブジェクト）かどうか。"""
    return isinstance(x, dict)


def _is_finite_number(x: Any) -> bool:
    """有限数（bool を除く int / float）かどうか。"""
    if isinstance(x, bool):
        return False
    return isinstance(x, (int, float)) and math.isfinite(x)


def _is_cell(x: Any) -> bool:
    """セル値は文字列、または有限数のみを許可する。"""
    return isinstance(x, str) or _is_finite_number(x)


def _canon_number(n: float) -> float | int:
    """`-0.0` を `0` に畳み込み、round-trip の等価比較を安定させる。"""
    return 0 if n == 0 else n


def _is_category_series(series: Any) -> bool:
    """カテゴリ系列（bar / pie）の形状判定。空リストは真（vacuously）。"""
    return isinstance(series, list) and all(
        _is_plain_object(d)
        and isinstance(d.get("label"), str)
        and _is_finite_number(d.get("value"))
        for d in series
    )


def _is_line_series(series: Any) -> bool:
    """line 系列の形状判定。空リストは真（vacuously）。"""
    if not isinstance(series, list):
        return False
    for s in series:
        if not _is_plain_object(s) or not isinstance(s.get("name"), str):
            return False
        points = s.get("points")
        if not isinstance(points, list):
            return False
        for pt in points:
            if not _is_plain_object(pt):
                return False
            x = pt.get("x")
            if not (isinstance(x, str) or _is_finite_number(x)):
                return False
            if not _is_finite_number(pt.get("y")):
                return False
    return True


def _is_valid_table(columns: Any, rows: Any) -> bool:
    """table の columns / rows 形状判定（各行長は columns 長と一致）。"""
    if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
        return False
    if not isinstance(rows, list):
        return False
    return all(
        isinstance(row, list)
        and len(row) == len(columns)
        and all(_is_cell(cell) for cell in row)
        for row in rows
    )


def is_valid_visualization(payload: Any) -> bool:
    """スキーマ適合判定（純粋述語）。`schema.ts` の `isValidVisualization` と一致。

    type ごとに以下を要求する:
      - bar / pie: `series` が CategoryDatum[]（columns / rows は無視）
      - line:      `series` が LineSeries[]
      - table:     `columns` が string[]、`rows` が各行長 = columns 長のセル配列。
                   `series` は list であること（正準形では空配列）
    """
    if not _is_plain_object(payload):
        return False
    if not isinstance(payload.get("title"), str):
        return False

    vtype = payload.get("type")
    if vtype in ("bar", "pie"):
        return _is_category_series(payload.get("series"))
    if vtype == "line":
        return _is_line_series(payload.get("series"))
    if vtype == "table":
        return isinstance(payload.get("series"), list) and _is_valid_table(
            payload.get("columns"), payload.get("rows")
        )
    return False


def normalize_visualization(payload: dict[str, Any]) -> dict[str, Any]:
    """検証済み入力を正準形へ正規化する（`schema.ts` の `normalizeVisualization`）。

    型に応じてデータフィールドのみを保持し、余分なプロパティを落とす。数値は
    `-0` を `0` に畳み込む。正規化は冪等（`normalize(normalize(p)) == normalize(p)`）。

    前提: `is_valid_visualization(payload)` が真であること。
    """
    title = payload["title"]
    vtype = payload["type"]

    if vtype in ("bar", "pie"):
        series = [
            {"label": d["label"], "value": _canon_number(d["value"])}
            for d in payload["series"]
        ]
        return {"type": vtype, "title": title, "series": series}

    if vtype == "line":
        series = [
            {
                "name": s["name"],
                "points": [
                    {
                        "x": _canon_number(pt["x"])
                        if _is_finite_number(pt["x"])
                        else pt["x"],
                        "y": _canon_number(pt["y"]),
                    }
                    for pt in s["points"]
                ],
            }
            for s in payload["series"]
        ]
        return {"type": "line", "title": title, "series": series}

    # table
    columns = list(payload.get("columns") or [])
    rows = [
        [_canon_number(cell) if _is_finite_number(cell) else cell for cell in row]
        for row in (payload.get("rows") or [])
    ]
    return {"type": "table", "title": title, "series": [], "columns": columns, "rows": rows}


def build_visualization_event(payload: dict[str, Any]) -> CustomEvent:
    """可視化ペイロードを AG-UI `CustomEvent` として構築する（Req 1.3, 8.4）。

    ペイロードを検証し、適合するもののみ正規化して CustomEvent の value に載せる。
    フロントはこの value を `parseVisualization()` に通して描画する。

    Args:
        payload: フロントと合意した Visualization_Payload 構造の dict。

    Returns:
        `name = VISUALIZATION_EVENT_NAME`、`value = 正規化済みペイロード` の CustomEvent。

    Raises:
        ValueError: ペイロードが Visualization_Schema に適合しない場合。
    """
    if not is_valid_visualization(payload):
        raise ValueError(
            "payload does not conform to Visualization_Schema "
            f"(type must be one of {SUPPORTED_VISUALIZATION_TYPES})"
        )
    return CustomEvent(
        name=VISUALIZATION_EVENT_NAME,
        value=normalize_visualization(payload),
    )
