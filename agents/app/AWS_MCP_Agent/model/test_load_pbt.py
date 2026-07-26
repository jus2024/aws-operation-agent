"""Tests for Bedrock model resolution (model/load.py).

`load_model()` そのものは Strands `BedrockModel`（IAM/ネットワーク依存）を構築するため
統合スモークで扱い（task 11.7）、ここでは env-var 構成とリージョン解決の **純粋関数**
（`resolve_geo_prefix` / `resolve_model_id`）を検証する。エージェント方針（設定・
ランタイムロジックの分離）に従い、モデル ID 解決は副作用なしの全域関数に切り出して
ある。

検証内容:
  - リージョン → クロスリージョン推論プロファイル prefix の写像（us / global のみ）
    既定モデル `anthropic.claude-sonnet-5` は `us.*` と `global.*` の推論プロファイル
    しか存在しない（Bedrock ListInferenceProfiles で実機確認済み）ため、`us-*` は
    `us`、それ以外（`eu-*` / `ap-*` / 不明 / 空 / None）は全て `global` に写像する。
  - `BEDROCK_MODEL_ID` override が指定時は verbatim で優先されること
  - override 未指定時は既定モデル（Claude Sonnet 5）の region-prefixed プロファイル
  - 解決結果は必ず既知の prefix + 既定ベース ID で構成される全域性

実行: パッケージルート（`agents/app/AWS_MCP_Agent`）から
`uv run pytest model/test_load_pbt.py`。

Requirements: 9.7, 8.4
"""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from model.load import (
    DEFAULT_MODEL_BASE_ID,
    resolve_geo_prefix,
    resolve_model_id,
)

_KNOWN_PREFIXES = ("us", "global")


class TestResolveGeoPrefix:
    def test_known_region_mappings(self) -> None:
        """`us-*` は `us`、それ以外は `global` に写像される。"""
        assert resolve_geo_prefix("us-west-2") == "us"
        assert resolve_geo_prefix("us-east-1") == "us"
        # 既定モデルは us.* / global.* のプロファイルしか無いため、
        # us 以外の地域は全て global に寄せる。
        assert resolve_geo_prefix("eu-central-1") == "global"
        assert resolve_geo_prefix("ap-northeast-1") == "global"
        assert resolve_geo_prefix("ap-southeast-2") == "global"
        assert resolve_geo_prefix("ap-southeast-4") == "global"

    def test_unknown_or_empty_falls_back_to_global(self) -> None:
        """未知・空・None は global へフォールバックする。"""
        assert resolve_geo_prefix(None) == "global"
        assert resolve_geo_prefix("") == "global"
        assert resolve_geo_prefix("ap-south-1") == "global"
        assert resolve_geo_prefix("sa-east-1") == "global"

    def test_case_insensitive(self) -> None:
        """大文字・前後空白でも安定して解決する。"""
        assert resolve_geo_prefix("US-WEST-2") == "us"
        assert resolve_geo_prefix("  us-east-1  ") == "us"
        assert resolve_geo_prefix("  ap-northeast-1  ") == "global"

    @given(st.one_of(st.none(), st.text(max_size=20)))
    def test_is_total_and_returns_known_prefix(self, region: str | None) -> None:
        """任意入力に対し例外を投げず、既知 prefix のいずれかを返す（全域）。"""
        assert resolve_geo_prefix(region) in _KNOWN_PREFIXES

    @given(st.text(max_size=20).map(lambda s: "us-" + s))
    def test_us_regions_map_to_us(self, region: str) -> None:
        """`us-` で始まるリージョンは必ず `us` に写像される。"""
        assert resolve_geo_prefix(region) == "us"

    @given(
        st.one_of(st.none(), st.text(max_size=20)).filter(
            lambda r: not (r and r.strip().lower().startswith("us-"))
        )
    )
    def test_non_us_maps_to_global(self, region: str | None) -> None:
        """`us-` で始まらない任意入力は必ず `global` に写像される。"""
        assert resolve_geo_prefix(region) == "global"


class TestResolveModelId:
    def test_override_wins_verbatim(self) -> None:
        """override 指定時はそのまま採用される（region は無視）。"""
        assert (
            resolve_model_id("anthropic.claude-sonnet-4-6", "us-west-2")
            == "anthropic.claude-sonnet-4-6"
        )
        assert (
            resolve_model_id("  global.anthropic.claude-sonnet-5  ", None)
            == "global.anthropic.claude-sonnet-5"
        )

    def test_default_is_region_prefixed_sonnet5(self) -> None:
        """override 未指定時は region-prefixed の既定モデルを返す。"""
        assert resolve_model_id(None, "us-west-2") == f"us.{DEFAULT_MODEL_BASE_ID}"
        assert (
            resolve_model_id(None, "ap-northeast-1")
            == f"global.{DEFAULT_MODEL_BASE_ID}"
        )
        assert resolve_model_id(None, None) == f"global.{DEFAULT_MODEL_BASE_ID}"

    def test_blank_override_is_treated_as_unset(self) -> None:
        """空白のみの override は未指定扱い（既定へフォールバック）。"""
        assert resolve_model_id("", "us-west-2") == f"us.{DEFAULT_MODEL_BASE_ID}"
        assert (
            resolve_model_id("   ", "eu-central-1")
            == f"global.{DEFAULT_MODEL_BASE_ID}"
        )

    @given(
        override=st.one_of(st.none(), st.just(""), st.just("   ")),
        region=st.one_of(st.none(), st.text(max_size=20)),
    )
    def test_default_resolution_is_total(
        self, override: str | None, region: str | None
    ) -> None:
        """override 実質未指定時、結果は必ず既知 prefix + 既定ベース ID で構成される。"""
        model_id = resolve_model_id(override, region)
        prefix, _, base = model_id.partition(".")
        assert prefix in _KNOWN_PREFIXES
        assert base == DEFAULT_MODEL_BASE_ID
