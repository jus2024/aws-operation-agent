"""Property-based tests for the Agent-side Visualization_Schema (schema.py).

フロント（`src/lib/agent/visualization/schema.pbt.test.ts`）の PBT スイートを
Python / `hypothesis` へ移植したもの。Agent 側とフロント側で **合意された同一構造**
の `Visualization_Payload` に対し、検証（`is_valid_visualization`）・正規化
（`normalize_visualization`）・AG-UI 送出（`build_visualization_event`）が
同じ普遍的性質を満たすことを確認する。

対応する Correctness Properties（design.md）:
  - Property 1: validate/normalize ラウンドトリップ（正規化後も再検証を満たす・
    type/データ値を保存・冪等）
  - Property 2: 検証は全域であり非適合は必ず False へ分類される（例外を投げない）

実行: パッケージルート（`agents/app/AWS_MCP_Agent`）から
`uv run pytest visualization/test_schema_pbt.py`（各プロパティ >= 100 例）。

Requirements: 1.3
"""

from __future__ import annotations

from typing import Any

import pytest
from ag_ui.core import CustomEvent
from hypothesis import given
from hypothesis import strategies as st

from visualization.schema import (
    SUPPORTED_VISUALIZATION_TYPES,
    VISUALIZATION_EVENT_NAME,
    build_visualization_event,
    is_valid_visualization,
    normalize_visualization,
)

# ---------------------------------------------------------------------------
# 生成器（フロント schema.pbt.test.ts のジェネレータと対応させる）
# ---------------------------------------------------------------------------

#: 有限数（0 / -0.0 / 大きな正負を含むエッジ）。`_is_finite_number` を満たす値のみ
#: （bool は除外）。
finite_numbers: st.SearchStrategy[float | int] = st.one_of(
    st.integers(min_value=-1_000_000, max_value=1_000_000),
    st.floats(min_value=-1e12, max_value=1e12, allow_nan=False, allow_infinity=False),
    st.just(0),
    st.just(-0.0),
    st.just(1e12),
    st.just(-1e12),
)

#: ラベル / 名前 / セル文字列（空文字・Unicode を含む）。
labels: st.SearchStrategy[str] = st.text(max_size=12)

#: セル値: 文字列 または 有限数（`_is_cell` と整合）。
cells: st.SearchStrategy[str | float | int] = st.one_of(labels, finite_numbers)

#: bar / pie のカテゴリ系列（空系列を含む）。
category_series: st.SearchStrategy[list[dict[str, Any]]] = st.lists(
    st.fixed_dictionaries({"label": labels, "value": finite_numbers}),
    max_size=8,
)

#: line 系列（点の x は文字列/数値、y は有限数。空系列・空点列を含む）。
line_series: st.SearchStrategy[list[dict[str, Any]]] = st.lists(
    st.fixed_dictionaries(
        {
            "name": labels,
            "points": st.lists(
                st.fixed_dictionaries(
                    {"x": st.one_of(labels, finite_numbers), "y": finite_numbers}
                ),
                max_size=8,
            ),
        }
    ),
    max_size=5,
)

bar_or_pie_payload: st.SearchStrategy[dict[str, Any]] = st.fixed_dictionaries(
    {
        "type": st.sampled_from(["bar", "pie"]),
        "title": labels,
        "series": category_series,
    }
)

line_payload: st.SearchStrategy[dict[str, Any]] = st.fixed_dictionaries(
    {"type": st.just("line"), "title": labels, "series": line_series}
)


@st.composite
def table_payload(draw: st.DrawFn) -> dict[str, Any]:
    """table（各行長 = columns 長を保証）。空テーブルを含む。"""
    columns = draw(st.lists(labels, max_size=6))
    rows = draw(
        st.lists(
            st.lists(cells, min_size=len(columns), max_size=len(columns)),
            max_size=10,
        )
    )
    return {
        "type": "table",
        "title": draw(labels),
        "series": [],
        "columns": columns,
        "rows": rows,
    }


#: Schema 適合の任意ペイロード（4 型混在）。
valid_payload: st.SearchStrategy[dict[str, Any]] = st.one_of(
    bar_or_pie_payload, line_payload, table_payload()
)


# ---------------------------------------------------------------------------
# 参照ヘルパー（normalize 内部を再利用しない独立実装）
# ---------------------------------------------------------------------------


def _ref_canon(v: Any) -> Any:
    """-0.0 を 0 に畳み込む独立正準化（比較の安定に用いる）。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v == 0:
        return 0
    return v


def _extract_values(p: dict[str, Any]) -> list[Any]:
    """ペイロードが保持する全データ値を順序を保って列挙する（独立実装）。"""
    vtype = p["type"]
    if vtype in ("bar", "pie"):
        out: list[Any] = []
        for d in p["series"]:
            out.append(d["label"])
            out.append(_ref_canon(d["value"]))
        return out
    if vtype == "line":
        out = []
        for s in p["series"]:
            for pt in s["points"]:
                out.append(s["name"])
                out.append(_ref_canon(pt["x"]))
                out.append(_ref_canon(pt["y"]))
        return out
    # table
    return [_ref_canon(cell) for row in (p.get("rows") or []) for cell in row]


# ===========================================================================
# Property 1: validate/normalize ラウンドトリップ
#
# Feature: ui-ux-enhancements, Property 1: validate/normalize ラウンドトリップ
# Validates: Requirements 1.3（フロント Req 1.6 と合意した同一構造）
#
# Schema 適合の Visualization_Payload p について:
#   (a) normalize_visualization(p) は再び is_valid_visualization を満たす。
#   (b) 正規化は type と全データ値を保存する（-0.0 は 0 と同一視）。
#   (c) 正規化は冪等である: normalize(normalize(p)) == normalize(p)。
# ===========================================================================


class TestProperty1RoundTrip:
    @given(valid_payload)
    def test_generator_produces_schema_conforming_payloads(
        self, p: dict[str, Any]
    ) -> None:
        """生成器は必ず Schema 適合ペイロードを生成する（前提条件）。"""
        assert is_valid_visualization(p) is True

    @given(valid_payload)
    def test_normalized_payload_revalidates(self, p: dict[str, Any]) -> None:
        """正規化後のペイロードは再び is_valid_visualization を満たす（round-trip）。"""
        normalized = normalize_visualization(p)
        assert is_valid_visualization(normalized) is True

    @given(valid_payload)
    def test_normalization_preserves_type_and_values(self, p: dict[str, Any]) -> None:
        """正規化は type と全データ値を保存する（独立参照正準化で比較）。"""
        normalized = normalize_visualization(p)
        assert normalized["type"] == p["type"]
        assert _extract_values(normalized) == _extract_values(p)
        if p["type"] == "table":
            assert (normalized.get("columns") or []) == (p.get("columns") or [])

    @given(valid_payload)
    def test_normalization_is_idempotent(self, p: dict[str, Any]) -> None:
        """正規化は冪等: normalize(normalize(p)) == normalize(p)。"""
        once = normalize_visualization(p)
        twice = normalize_visualization(once)
        assert twice == once


# ===========================================================================
# Property 2: 検証は全域であり非適合は必ず False へ分類される
#
# Feature: ui-ux-enhancements, Property 2: 検証は全域でありフォールバックへ分類される
# Validates: Requirements 1.3（フロント Req 1.1, 1.4, 1.5 と合意した同一構造）
#
# 任意入力 x に対し is_valid_visualization(x) は例外を投げず bool を返す。
# 対応型でない / スキーマ非適合 / 非オブジェクトは必ず False。
# build_visualization_event は適合ペイロードのみ正規化済み CustomEvent を返し、
# 非適合には ValueError を送出する（黙ってイベントを作らない）。
# ===========================================================================


#: type が対応 4 種でない文字列のペイロード（→ False 期待）。
unsupported_type_payload: st.SearchStrategy[dict[str, Any]] = st.builds(
    lambda t, title: {"type": t, "title": title, "series": []},
    st.text(max_size=12).filter(lambda s: s not in SUPPORTED_VISUALIZATION_TYPES),
    labels,
)


@st.composite
def _table_row_length_mismatch(draw: st.DrawFn) -> dict[str, Any]:
    """table だが行長が columns 長と一致しないペイロード（→ 非適合）。"""
    columns = draw(st.lists(labels, min_size=1, max_size=4))
    bad_len = draw(
        st.integers(min_value=0, max_value=6).filter(lambda n: n != len(columns))
    )
    rows = draw(
        st.lists(
            st.lists(cells, min_size=bad_len, max_size=bad_len), min_size=1, max_size=4
        )
    )
    return {
        "type": "table",
        "title": draw(labels),
        "series": [],
        "columns": columns,
        "rows": rows,
    }


#: 対応型だがスキーマ非適合のペイロード（→ False 期待）。
invalid_structure_payload: st.SearchStrategy[dict[str, Any]] = st.one_of(
    # bar/line/pie だが series が壊れている（空配列は vacuously valid のため除外）
    st.fixed_dictionaries(
        {
            "type": st.sampled_from(["bar", "line", "pie"]),
            "title": labels,
            "series": st.one_of(
                st.none(),
                st.integers(),
                st.text(),
                st.lists(st.fixed_dictionaries({"label": st.integers()}), min_size=1),
            ),
        }
    ),
    # table だが行長が columns 長と不一致
    _table_row_length_mismatch(),
    # title が文字列でない
    st.fixed_dictionaries(
        {
            "type": st.sampled_from(list(SUPPORTED_VISUALIZATION_TYPES)),
            "title": st.one_of(st.integers(), st.none()),
            "series": category_series,
        }
    ),
)

#: JSON ライクな任意入力（構造不明・非オブジェクトを含む）。
_arbitrary_input: st.SearchStrategy[Any] = st.recursive(
    st.one_of(
        st.none(),
        st.booleans(),
        st.integers(),
        st.floats(allow_nan=False, allow_infinity=False),
        st.text(max_size=8),
    ),
    lambda children: st.one_of(
        st.lists(children, max_size=4),
        st.dictionaries(st.text(max_size=6), children, max_size=4),
    ),
    max_leaves=12,
)

#: 全分類を混在させた任意入力。
mixed_input: st.SearchStrategy[Any] = st.one_of(
    _arbitrary_input,
    valid_payload,
    unsupported_type_payload,
    invalid_structure_payload,
)


class TestProperty2TotalValidation:
    @given(mixed_input)
    def test_is_valid_is_total_and_returns_bool(self, x: Any) -> None:
        """任意入力に対し例外を投げず bool を返し、True なら再検証を満たす。"""
        result = is_valid_visualization(x)
        assert isinstance(result, bool)
        if result:
            normalized = normalize_visualization(x)
            assert normalized["type"] in SUPPORTED_VISUALIZATION_TYPES
            assert is_valid_visualization(normalized) is True

    @given(valid_payload)
    def test_valid_payloads_are_accepted(self, p: dict[str, Any]) -> None:
        """スキーマ適合かつ対応型の入力は常に True。"""
        assert is_valid_visualization(p) is True

    @given(unsupported_type_payload)
    def test_unsupported_types_are_rejected(self, p: dict[str, Any]) -> None:
        """対応 4 種でない type は常に False。"""
        assert is_valid_visualization(p) is False

    @given(invalid_structure_payload)
    def test_invalid_structures_are_rejected(self, p: dict[str, Any]) -> None:
        """対応型だがスキーマ非適合は常に False。"""
        assert is_valid_visualization(p) is False

    @given(
        st.one_of(
            st.none(),
            st.integers(),
            st.text(),
            st.booleans(),
            st.lists(st.integers(), max_size=3),
            st.just(-0.0),
        )
    )
    def test_non_objects_are_rejected(self, x: Any) -> None:
        """dict でない入力は常に False。"""
        assert is_valid_visualization(x) is False


# ===========================================================================
# 合意構造の送出（build_visualization_event）
#
# Feature: ui-ux-enhancements, Property 2 (送出境界): 適合のみ正規化済みイベント化
# Validates: Requirements 1.3, 8.4
# ===========================================================================


class TestBuildVisualizationEvent:
    @given(valid_payload)
    def test_valid_payload_builds_normalized_custom_event(
        self, p: dict[str, Any]
    ) -> None:
        """適合ペイロードは name/value が合意構造の CustomEvent になる。"""
        event = build_visualization_event(p)
        assert isinstance(event, CustomEvent)
        assert event.name == VISUALIZATION_EVENT_NAME
        # value は正規化済みで、再検証を満たす（フロント parseVisualization が受理）
        assert event.value == normalize_visualization(p)
        assert is_valid_visualization(event.value) is True

    @given(st.one_of(unsupported_type_payload, invalid_structure_payload))
    def test_invalid_payload_raises_value_error(self, p: dict[str, Any]) -> None:
        """非適合ペイロードは黙ってイベント化せず ValueError を送出する。"""
        with pytest.raises(ValueError):
            build_visualization_event(p)
