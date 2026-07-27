"""Import verification + multimodal acceptance smoke for the Agent (task 11.7).

このモジュールは task 11.7 の **コーディング対象部分** をカバーする軽量テスト。
最も狭い範囲の検証を優先する `testing` ルールに従い、ネットワーク・AWS 認証・
サーバー起動を要さない範囲で以下を自動検証する:

1. **インポート確認** — エージェント自身の各リーフモジュール（`main.py` を除く）が
   例外なくインポートできること。`main.py` はモジュール読み込み時に `MCPClient` /
   テンプレート Agent を構築する副作用（サブプロセス起動）を持つため import せず、
   別途 `py_compile` と後述の起動スモークで担保する。
2. **マルチモーダル受理境界** — AG-UI の text + base64 画像ブロック
   （`TextInputContent` + `ImageInputContent`）が、`model/load.py` の docstring が
   依拠する `ag_ui_strands.utils.convert_agui_content_to_strands` によって Strands
   Converse のコンテンツブロック（`{"text": ...}` と `{"image": {...}}`）へ変換され、
   画像バイトが復元されること（Req 9.7 が要求する「インライン画像を受理」の境界）。
3. **ビジョン対応モデル解決** — 既定解決が Converse/ビジョン対応の Claude Sonnet 5
   クロスリージョン推論プロファイルになること（`model/load.py`）。設定は
   `BEDROCK_MODEL_ID` で上書き可能でハードコードしない。

実行: パッケージルート（`agents/app/AWS_MCP_Agent`）から
`uv run pytest model/test_multimodal_smoke.py`。

--------------------------------------------------------------------------
手動スモーク手順（コーディング対象外 / ローカルでサーバー起動が必要なため自動化しない）
--------------------------------------------------------------------------
フロント↔Agent の結合は SigV4 + コンピューティングロールが必要でローカル不可のため、
Amplify Hosting のデプロイ環境で確認する（`testing` ルール）。Agent 単体の
`/invocations` 受理確認はローカルで以下により行える（AgentCore Runtime 不要）:

    # 1) 依存を同期して AG-UI サーバーをローカル起動（Runtime 不要）
    cd agents/app/AWS_MCP_Agent
    uv sync
    LOCAL_DEV=1 uv run python main.py          # もしくは: agentcore dev
    #   -> http://0.0.0.0:8080 で起動（/ping, /invocations）

    # 2) text + base64 画像ブロックを含む AG-UI RunAgentInput を投げる
    #    （PNG 1x1 の base64 例。messages[].content に text と image を並べる）
    PNG_B64=$(printf '\x89PNG\r\n\x1a\n' | base64)   # 実際は有効な PNG を使う
    curl -sN http://localhost:8080/invocations \
      -H 'Content-Type: application/json' \
      -H 'Accept: text/event-stream' \
      -d '{
        "thread_id": "t-smoke",
        "run_id": "r-smoke",
        "messages": [{
          "id": "m1", "role": "user",
          "content": [
            {"type": "text", "text": "この画像には何が写っていますか?"},
            {"type": "image",
             "source": {"type": "data", "mime_type": "image/png", "value": "'"$PNG_B64"'"}}
          ]
        }],
        "tools": [], "context": [], "state": {}, "forwarded_props": {}
      }'

    # 3) 期待: 4xx/5xx で拒否されず AG-UI イベントがストリームされ、応答本文が
    #    画像内容に言及すること（ビジョンモデルが画像を参照した証跡）。
    #    BEDROCK_MODEL_ID 未設定時は region 解決の Claude Sonnet 5 プロファイルを使用。
    #    対象リージョンで Sonnet 5 が受理されない場合は BEDROCK_MODEL_ID に
    #    FALLBACK_MODEL_ID（anthropic.claude-sonnet-4-6）等を設定する。

Requirements: 9.7
"""

from __future__ import annotations

import base64
import importlib

import pytest

from model.load import (
    DEFAULT_MODEL_BASE_ID,
    resolve_model_id,
)

#: `main.py` を除くエージェント自身のリーフモジュール。import 時に副作用（サブプロセス
#: 起動・ネットワーク・AWS 認証）を持たないものだけを列挙する。
AGENT_LEAF_MODULES: tuple[str, ...] = (
    "context.session_context",
    "gateway.client",
    "gateway.error_classification",
    "gateway.manager",
    "memory.session",
    "model.load",
    "prompts.system",
    "roles.config",
    "roles.hook",
    "roles.store",
    "roles.sts",
    "roles.tool_schema",
    "scope.enforcement",
    "visualization.schema",
    "visualization.tool",
)


class TestImportVerification:
    """エージェントモジュールのインポート確認（ruff lint と並ぶ最優先の静的検証）。"""

    @pytest.mark.parametrize("module_name", AGENT_LEAF_MODULES)
    def test_leaf_module_imports_without_error(self, module_name: str) -> None:
        """各リーフモジュールが例外なくインポートできる。"""
        module = importlib.import_module(module_name)
        assert module is not None


class TestMultimodalAcceptanceBoundary:
    """AG-UI text + base64 画像ブロックの受理・変換境界（Req 9.7）。

    Agent は `ag_ui_strands` が AG-UI の `ImageInputContent` を Strands Converse の
    画像コンテンツブロックへ変換した結果を、`model/load.py` が用意するビジョン対応
    モデルへ渡す。ここではその変換境界が text+画像を受理し、画像バイトを保持した
    image ブロックを生成することを確認する。
    """

    @staticmethod
    def _build_agui_content() -> tuple[list[object], bytes]:
        from ag_ui_strands.utils import (
            ImageInputContent,
            InputContentDataSource,
            TextInputContent,
        )

        raw = b"\x89PNG\r\n\x1a\n fake-png-bytes"
        b64 = base64.b64encode(raw).decode()
        text = TextInputContent(type="text", text="この画像には何が写っていますか?")
        image = ImageInputContent(
            type="image",
            source=InputContentDataSource(
                type="data", value=b64, mime_type="image/png"
            ),
        )
        return [text, image], raw

    def test_text_plus_image_is_accepted_and_converted(self) -> None:
        """text + base64 画像が Strands の text/image ブロックへ変換される。"""
        from ag_ui_strands.utils import convert_agui_content_to_strands

        content, raw = self._build_agui_content()
        blocks = convert_agui_content_to_strands(content)

        assert len(blocks) == 2
        assert blocks[0].get("text") == "この画像には何が写っていますか?"

        image_block = blocks[1].get("image")
        assert image_block is not None, "画像ブロックが受理・生成されていない"
        assert image_block["format"] == "png"
        # base64 がデコードされ、元の生バイトが保持されている（黙って破棄されない）。
        assert image_block["source"]["bytes"] == raw

    def test_text_only_is_accepted(self) -> None:
        """テキストのみの入力も同じ経路で受理される（画像必須ではない）。"""
        from ag_ui_strands.utils import (
            TextInputContent,
            convert_agui_content_to_strands,
        )

        blocks = convert_agui_content_to_strands(
            [TextInputContent(type="text", text="hello")]
        )
        assert blocks == [{"text": "hello"}]


class TestVisionModelResolution:
    """既定のモデル解決がビジョン対応 Sonnet 5 プロファイルであること（Req 9.7）。"""

    def test_default_resolves_to_vision_capable_sonnet5_profile(self) -> None:
        """override 未指定時は region-prefixed の既定（Sonnet 5）を返す。"""
        # 既定モデルは us.* / global.* のプロファイルしか無いため、us-* は us、
        # それ以外（ap-northeast-1 等）は global に解決される。
        assert resolve_model_id(None, "us-west-2") == f"us.{DEFAULT_MODEL_BASE_ID}"
        assert (
            resolve_model_id(None, "ap-northeast-1")
            == f"global.{DEFAULT_MODEL_BASE_ID}"
        )

    def test_env_override_is_respected(self) -> None:
        """BEDROCK_MODEL_ID 相当の override はハードコードされず verbatim で優先される。"""
        assert (
            resolve_model_id("anthropic.claude-sonnet-4-6", "us-west-2")
            == "anthropic.claude-sonnet-4-6"
        )
