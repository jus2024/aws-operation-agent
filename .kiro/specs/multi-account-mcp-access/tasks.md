# Implementation Plan: マルチアカウント MCP アクセス（全面改定）

## Overview

本実装計画は、既存の「接続カタログ (Connection Catalog)」と「chat-session-history」機能を全面改定し、`mcp-proxy-for-aws` のマルチプロファイル機能による真のマルチアカウント対応を実現するためのコーディングタスクである。

実装言語（設計踏襲）:
- フロントエンド / API Route: **TypeScript**（プロパティテスト = `fast-check`）
- エージェント: **Python 3.12〜3.13**（プロパティテスト = `hypothesis`）

進め方: Amplify データモデル（他レイヤーの前提）→ エージェント（セッションコンテキスト → 純粋関数 → 接続方式変更 → フック新規実装 → 結線）→ フロントエンド（接続解決/ヘッダー構築 → 純粋関数 + PBT → コンポーネント → ページ統合）の順に進める。各タスク完了後は最も狭い範囲の検証（lint/型チェック/PBT/スモークテスト）を実施する（testing 方針）。各 PBT は最低 100 イテレーション、タグ `Feature: multi-account-mcp-access, Property {n}: {description}` を付し、1 プロパティ = 1 PBT とする。

### 高感度タスク（PR レビュー必須・security / repo-workflow ルール）

設計の F1〜F5 に対応する。IAM / 認証情報 / 認証経路 / 全セッション共有ロジックに関わるため、PR レビューで明示確認する。

- **F4 / 1.x** Amplify データモデルの破壊的変更（`gatewayUrl` 削除、`awsProfileName` 追加必須化、`endedAt` 削除、`operationScope` 必須化）
- **F3 / 2.x, 7.x, 9.x** セッションコンテキストのヘッダー変更（`X-Gateway-Url` → `X-Aws-Profile`）と `contextvars` によるリクエストスコープ分離、API Route のヘッダー伝播ロジック
- **F1 / F2 / 4.x** エージェントの接続方式変更（直接 SigV4 → `mcp-proxy-for-aws` stdio サブプロセス）。Runtime 実行環境への複数プロファイル認証情報プロビジョニング（Requirement 7）の前提となる
- **F5 / 5.x** `BeforeToolCallEvent` フック（`profile/injection.py`）— 全セッション共有のスコープ強制 + `aws_profile` 注入/拒否ロジック

---

## Tasks

- [x] 1. Amplify データモデル全面改定（高感度・破壊的スキーマ変更 F4）
  - [x] 1.1 `amplify/data/resource.ts` を更新する
    - `Connection`: `gatewayUrl` フィールドを削除し、`awsProfileName: a.string().required()` を追加する（`mcp-proxy-for-aws` に渡す AWS CLI プロファイル名。AppSync ではパターン制約を宣言できないため、1-64文字・許可文字種の制約はコメントで明記し、実施はフロントエンド検証側に委ねる旨を記す）
    - `Connection`: `displayName` / `awsAccountId` / `awsRegion` / `description` は変更なし。認可（`allow.group("ADMINS")` + `allow.authenticated().to(["read"])`）は維持する
    - `ChatSession`: `endedAt` フィールドを削除し、`operationScope` を `.required()` に変更する（enum 値は変更なし）。`connectionId` / `ownerUserId` / `sessionName` / `startedAt` / `updatedAt` は変更なし。`allow.owner()` は維持する
    - 破壊的変更である旨と移行手順（sandbox は `amplify sandbox delete` で再作成、本番は手動データ移行または全面再登録）をコードコメントに明記する（Migration Plan 要約、Requirement 8.1）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8.1, 8.2_
    - **高感度（F4）**: 既存カタログ/セッションデータへの影響がある。デプロイ影響（sandbox 再作成が必要、本番は移行手順に従う）を PR に明記する
    - 検証: 型チェック（生成される `Schema` 型に `gatewayUrl`/`endedAt` が存在しないこと、`awsProfileName` が必須型であることを確認）。Amplify 変更はデプロイ・設定への影響を記載する（testing 方針）

- [x] 2. エージェント: セッションコンテキストのヘッダー変更（高感度 F3）
  - [x] 2.1 `agents/app/AWS_MCP_Agent/context/session_context.py` を更新する
    - `HEADER_GATEWAY_URL = "X-Gateway-Url"` を `HEADER_AWS_PROFILE = "X-Aws-Profile"` に置換する
    - `SessionContext.gateway_url: str` を `aws_profile_name: str | None` に変更する（欠如/空文字は `None`、例外にしない）
    - `MissingGatewayUrlError` を削除する
    - `extract_session_context()` を、`X-Aws-Profile` 欠如時に例外を投げず `aws_profile_name=None` を設定するロジックに変更する。`X-Operation-Scope` の検証・デフォルト解決（`DEFAULT_SCOPE = "readonly"`）ロジックは維持する
    - _Requirements: 2.2, 2.3, 8.4_
    - **高感度（F3）**: セッションコンテキストのヘッダー契約の変更。認証済みユーザーのリクエストにのみ正しく紐づくことを PR で確認する

  - [x] 2.2 `agents/app/AWS_MCP_Agent/context/test_session_context.py` を更新する
    - `MissingGatewayUrlError` 関連のテストケースを削除する
    - `X-Aws-Profile` が存在/欠如/空/空白の各ケースで `aws_profile_name` が期待通り（値 or `None`）に解決されることを検証するテストに置き換える
    - `X-Operation-Scope` の既存の検証テスト（大小文字非依存、不正値のデフォルト解決等）は維持する
    - _Requirements: 2.2, 2.3, 8.4_

- [x] 3. エージェント: プロファイル一覧重複排除の純粋関数（Property 1）
  - [x] 3.1 `agents/app/AWS_MCP_Agent/profile/proxy_profiles.py` を新規作成する
    - `build_proxy_profiles_env(profile_names: Iterable[str]) -> str`: 各値をトリムし、空/空白のみの値を除外し、初出順を保持して重複を排除したうえでスペース区切りの文字列を構築する（`AWS_MCP_PROXY_PROFILES` 相当値）
    - この関数は運用ドキュメント/デプロイスクリプト側から呼ばれる想定だが、ロジックはユニットとして分離してテスト可能にする
    - _Requirements: 1.3_

  - [ ]* 3.2 `agents/app/AWS_MCP_Agent/profile/test_proxy_profiles_pbt.py` を新規作成する
    - **Property 1: プロファイル一覧の重複排除**
    - **Validates: Requirements 1.3**
    - `hypothesis` で、空/空白混在/重複を含む任意のプロファイル名リストに対し、出力が「初出順を保持した非空トリム済み値の重複排除リスト」のスペース区切りと一致することを検証する（最低100イテレーション）

- [x] 4. エージェント: mcp-proxy-for-aws 接続への移行（高感度 F1/F2）
  - [x] 4.1 `agents/app/AWS_MCP_Agent/gateway/client.py` を更新する
    - `build_aws_mcp_client()`（直接 SigV4 接続）を削除する
    - `build_aws_mcp_proxy_client(endpoint: str, region: str) -> MCPClient` を新規追加する。`mcp-proxy-for-aws` を `StdioServerParameters(command="mcp-proxy-for-aws", args=[endpoint, "--service", "aws-mcp", "--region", region])` で stdio サブプロセスとして起動し、`stdio_client` 経由で `MCPClient` を構築する（`startup_timeout=60`）
    - 接続失敗時の例外クラスを `McpProxyConnectionError` にリネームする（既存 `GatewayConnectionError` のパターンを流用）
    - `build_gateway_client()`（Gateway 直接接続用、本改定では未使用）にはコメントで用途変更（Gateway 概念は使わず MCP_Proxy への接続に用途変更、ディレクトリ名変更はスコープ外）を明記する
    - `AWS_MCP_PROXY_PROFILES` 環境変数はサブプロセスの環境変数として継承されるだけであり、本関数はこれを直接読まないことをコメントで明記する
    - _Requirements: 1.1, 1.2_
    - **高感度（F1/F2）**: 接続方式の変更は Runtime 実行環境への複数プロファイル認証情報プロビジョニング（Requirement 7）が前提となる。認証情報が正しくプロビジョニングされていない環境ではエージェント起動が失敗する

  - [ ]* 4.2 `agents/app/AWS_MCP_Agent/gateway/test_error_reporting.py` の import・参照を更新する
    - `build_aws_mcp_client` / `GatewayConnectionError` への直接参照があれば `build_aws_mcp_proxy_client` / `McpProxyConnectionError` に更新し、既存の接続失敗レポーティングテスト（Requirement 1.2 相当）が新例外クラスで通ることを確認する
    - _Requirements: 1.2_

- [x] 5. エージェント: BeforeToolCallEvent フック新規実装 + スコープ独立性検証（高感度 F5）
  - [x] 5.1 `agents/app/AWS_MCP_Agent/profile/injection.py` を新規作成する
    - `current_session_context: contextvars.ContextVar[SessionContext | None]`（デフォルト `None`）を定義する
    - `AUTH_REQUIRING_TOOLS = frozenset({"call_aws", "run_script", "get_presigned_url", "get_tasks", "suggest_aws_commands"})` を定義する
    - `SessionScopeAndProfileHook(HookProvider)`: `register_hooks()` で `BeforeToolCallEvent` を購読し、`_on_before_tool_call()` で (a) `scope.enforcement.is_allowed(tool_name, scope)` によるスコープ強制拒否、(b) 対象ツールのスキーマ（`event.selected_tool.tool_spec.inputSchema.json.properties`）に `aws_profile` が存在する場合のみ、`ctx.aws_profile_name` が非空ならそれを `tool_use["input"]["aws_profile"]` に注入して許可、非空でなければ `cancel_tool` で拒否メッセージを設定する（Requirement 2.5）
    - スキーマに `aws_profile` が存在しない場合（Multi_Profile_Mode 無効、Requirement 1.4/1.5）は注入も拒否も行わない
    - `aws_profile` が Runtime 実行環境で解決不可の場合の自動リトライを一切実装しない（Requirement 1.6 の遵守。`AfterToolCallEvent` フックは追加しない）。フック自身のエラー報告処理が失敗しても、ツール実行結果を成功として報告しないことだけを保証する best-effort ログ出力にとどめる（Requirement 1.7）
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.4, 2.5, 2.6_
    - **高感度（F5）**: 全セッションで共有される単一フックであり、実装ミスが全セッションに影響する。スコープ強制と `aws_profile` 注入の両方を担うため PR レビューで注意深く確認する

  - [ ]* 5.2 `agents/app/AWS_MCP_Agent/profile/test_injection_pbt.py` を新規作成する
    - **Property 5: `aws_profile` の注入または拒否の決定表**
    - **Validates: Requirements 2.4, 2.5, 7.5**
    - **Property 6: リクエスト間の `aws_profile` 分離**
    - **Validates: Requirements 2.6**
    - `hypothesis` + `pytest-asyncio` で、`aws_profile` を宣言するツールスキーマ/しないツールスキーマ、`aws_profile_name` の有無を組み合わせて注入/拒否/無変更の決定表を検証する（Property 5）。加えて `asyncio.gather` で複数の模擬 `BeforeToolCallEvent` を異なる `contextvars` コンテキストで並行実行し、各呼び出しの注入結果が自分自身のコンテキストとのみ一致することを検証する（Property 6、最低100イテレーション）

  - [ ]* 5.3 `agents/app/AWS_MCP_Agent/scope/test_enforcement_pbt.py` に Property 2 を追加する
    - **Property 2: 操作スコープ強制はプロファイルと独立**
    - **Validates: Requirements 1.8**
    - 既存の `is_allowed(tool_name, scope)` PBT に対し、`aws_profile` 値（存在/`None`/任意文字列）を独立変数として加え、同一 `(tool_name, scope)` の許可/拒否判定が `aws_profile` の値に関わらず常に同一であることを検証する（最低100イテレーション）
    - _Requirements: 1.8_

- [x] 6. エージェント: システムプロンプトの引数変更
  - [x] 6.1 `agents/app/AWS_MCP_Agent/prompts/system.py` を更新する
    - `build_system_prompt(gateway_url, operation_scope, available_tools=None)` から `gateway_url` 引数を削除する
    - 接続先の説明を「セッションに紐づく AWS プロファイル経由で操作する」という一般的な文言に変更し、具体的なプロファイル名や AWS アカウント ID をプロンプトに埋め込まない（プロンプトインジェクション対策・機密情報の最小化）
    - スコープ別の指示（`_build_scope_instruction`）とツールカテゴリ抽出（`_build_tools_section` / `_categorize_tools` / `_infer_category`）のロジックは変更しない
    - _Requirements: 8.3_

  - [ ]* 6.2 `agents/app/AWS_MCP_Agent/prompts/test_system.py` を更新する
    - `build_system_prompt` の呼び出しから `gateway_url` 引数を除去し、プロンプト本文に具体的な URL/プロファイル名/アカウント ID が含まれないことを検証するテストを追加する
    - _Requirements: 8.3_

- [x] 7. エージェント: main.py 自前 FastAPI ルート化 + 結線（高感度 F3）
  - [x] 7.1 `agents/app/AWS_MCP_Agent/main.py` を更新する
    - `create_strands_app()` / `add_strands_fastapi_endpoint()` の使用を廃止し、`FastAPI` インスタンスに `POST /invocations` と `GET /ping` を自前定義する
    - `/invocations` ハンドラーで `extract_session_context(request.headers)` → `current_session_context.set(ctx)` → `agui_agent.run(input_data)` を `StreamingResponse` + `EventEncoder` でストリーミングし、`finally` で `current_session_context.reset(token)` を呼ぶ
    - `_build_gateway_agent()` を `_build_template_agent()` にリネームし、`build_aws_mcp_proxy_client(endpoint=AWS_MCP_ENDPOINT, region=AWS_MCP_REGION)` を使用するよう変更する。`build_system_prompt` 呼び出しから `gateway_url` 引数を削除する
    - `StrandsAgent(..., hooks=[SessionScopeAndProfileHook()])` を登録する
    - コメントアウトされた `build_agent_for_session` の予約コードを削除する（Requirement 8.3）
    - CORS ミドルウェア（`CORSMiddleware`）を追加する
    - _Requirements: 1.1, 2.6, 8.3_
    - **高感度（F3）**: リクエストヘッダーの抽出と `contextvars` 設定は、認証済みリクエストのセッションコンテキストが他リクエストに漏れないことを保証する中核ロジックである。PR レビューで `finally` によるリセットの確実性を確認する

- [x] 8. Checkpoint - エージェントスモーク確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。エージェント変更はスモークテスト + インポート確認を優先する（testing 方針）。`uvicorn` または `agentcore dev` で起動し、curl で `/invocations` に `X-Aws-Profile` ヘッダーの有無を変えてリクエストを送り、注入/拒否の挙動差を確認する。`mcp-proxy-for-aws` サブプロセスの起動確認（ローカルではプロファイル未設定でも起動自体が失敗しないことを確認）を行う。

- [x] 9. フロントエンド: 接続解決・ヘッダー構築の移行（高感度 F3）
  - [x] 9.1 `src/lib/agent/connectionResolver.ts` を更新する
    - `ConnectionResolveInput.gatewayUrl` / `ResolvedConnection.gatewayUrl` を `awsProfileName?: string` に置換する
    - `buildProxyHeaders(operationScope: string, awsProfileName?: string): Record<string, string>` に変更する。`X-Operation-Scope` は常に設定し、`X-Aws-Profile` は現在の呼び出しで渡された `awsProfileName` が非空の場合のみ設定する（前回呼び出しの値を保持・フォールバックしない — 呼び出し側の責務であることを明記）
    - `validateAndExtractContext` は `connectionId` / `operationScope` 欠如時 400 を返す既存ロジックを維持し、`gatewayUrl` フォールバック処理を削除する
    - _Requirements: 2.2, 2.3, 8.4_
    - **高感度（F3）**

  - [ ]* 9.2 `src/lib/agent/connectionResolver.pbt.test.ts` を更新する
    - **Property 4: API Route のヘッダー構築と非引き継ぎ**
    - **Validates: Requirements 2.2, 2.3, 8.4**
    - `buildProxyHeaders` が `X-Operation-Scope` を常に現在のスコープに設定し、`X-Aws-Profile` は現在の呼び出しの `awsProfileName` が非空の場合にのみ設定し省略時は前回値を混入させないことを `fast-check` で検証する（最低100イテレーション）

  - [x] 9.3 `src/app/api/copilotkit/route.ts` を更新する
    - `frontendGatewayUrl` の抽出を `awsProfileName`（`props.awsProfileName`）の抽出に変更する
    - `_sessionHeaders` の構築を `buildProxyHeaders(operationScope, awsProfileName)` 呼び出しに置換し、`X-Gateway-Url` の送信を停止し `X-Aws-Profile` を送信するよう変更する
    - `connectionId`/`operationScope` が今回のリクエストに存在しない場合は既存ヘッダーを維持する既存挙動（CopilotKit の properties 省略対策）はそのまま残す。ログ出力の変数名（`frontendGatewayUrl` 等）も更新する
    - _Requirements: 2.2, 2.3, 8.4_
    - **高感度（F3）**: API Route のヘッダー伝播ロジックの変更。認証済みユーザーのセッションコンテキストが正しいリクエストにのみ紐づくことを PR で確認する

- [x] 10. フロントエンド: CopilotKit properties 構築の純粋関数化（Property 3）
  - [x] 10.1 `src/lib/agent/copilotProperties.ts` を新規作成する
    - `buildCopilotProperties(connectionId?: string, operationScope?: string, awsProfileName?: string): Record<string, string> | undefined` を実装する。3フィールドのうち非空の値のみキーを含めたオブジェクトを返し、全フィールドが空/未指定なら `undefined` を返す
    - _Requirements: 2.1, 5.4_

  - [ ]* 10.2 `src/lib/agent/copilotProperties.pbt.test.ts` を新規作成する
    - **Property 3: セッションコンテキストから CopilotKit properties への変換**
    - **Validates: Requirements 2.1, 5.4**
    - `connectionId` / `operationScope` / `awsProfileName` の存在・欠如・空文字の全組み合わせに対し、出力オブジェクトが非空フィールドのみを値変更なしで含み、空/欠如フィールドのキーを含まないことを `fast-check` で検証する（最低100イテレーション）

  - [x] 10.3 `src/lib/agent/CopilotProvider.tsx` を更新する
    - `CopilotProviderProps.gatewayUrl` を `awsProfileName?: string` にリネームする
    - `properties` の `useMemo` 構築ロジックを `buildCopilotProperties(connectionId, operationScope, awsProfileName)` 呼び出しに置換する
    - _Requirements: 2.1_

- [x] 11. フロントエンド: 接続フォーム入力検証の移行（Property 9）
  - [x] 11.1 `src/lib/agent/connectionValidation.ts` を更新する
    - `ConnectionInput.gatewayUrl` / `ValidationErrors.gatewayUrl` を `awsProfileName` に置換する
    - `isValidHttpsUrl` を削除し、`AWS_PROFILE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/` による検証に置換する（1〜64文字、英数字・ハイフン・アンダースコア・ピリオドのみ）
    - Requirement 6.1 の「1〜256文字」というフォーム欄の説明と、Data Model 制約（1〜64文字・制限charset）の矛盾について、**Data Model 制約を送信可否の判定基準として採用する**という設計判断をコードコメントに明記する（design.md Component 11 参照）
    - `displayName`（1〜100文字）/ `awsAccountId`（12桁数値）/ `awsRegion`（`[a-z]+-[a-z]+-[0-9]+`）の検証ロジックは変更しない
    - _Requirements: 6.2, 6.3, 6.4_

  - [ ]* 11.2 `src/lib/agent/connectionValidation.pbt.test.ts` を更新する
    - **Property 9: 接続フォームの入力検証ゲート**
    - **Validates: Requirements 6.2, 6.3, 6.4**
    - `gatewayUrl` 生成器を `awsProfileName`（有効: 1-64文字許可文字種のみ／無効: 空・空白のみ・65文字以上・許可外文字を含む）の生成器に置換し、全フィールド適合時のみ送信可・不適合時はフィールド単位エラー生成を `fast-check` で検証する（最低100イテレーション）

- [x] 12. フロントエンド: 既存 Connection の選択可否ゲート（Property 11、新規）
  - [x] 12.1 `src/lib/agent/connectionSelectability.ts` を新規作成する
    - `isConnectionSelectable(awsProfileName: string | null | undefined): boolean` を実装する。`awsProfileName` が存在し、かつトリム後に空でない場合のみ `true` を返す（移行前の既存 Connection で `awsProfileName` が未設定/空白のみのケースを想定）
    - _Requirements: 8.2_

  - [ ]* 12.2 `src/lib/agent/connectionSelectability.pbt.test.ts` を新規作成する
    - **Property 11: 既存 Connection の選択可否ゲート**
    - **Validates: Requirements 8.2**
    - `awsProfileName` が非空/未指定/空白のみ/空文字の全パターンに対し、選択可否の判定が仕様と一致することを `fast-check` で検証する（最低100イテレーション）

- [x] 13. フロントエンド: セッション復元リゾルバ（Property 8、新規）
  - [x] 13.1 `src/lib/agent/useSessionRestore.ts` を新規作成する
    - `RestoreResult` 型（`resolved` | `missing_connection` | `lookup_error` の判別可能ユニオン）を定義する
    - `resolveRestoredSession(storedConnectionId: string, storedOperationScope: string, lookup: () => Promise<{ data: Connection | null; error: string | null }>): Promise<RestoreResult>` を実装する。「見つからない」（`data === null && error === null`）と「その他のエラー」（`error !== null`）を明確に区別する
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7, 5.8_

  - [ ]* 13.2 `src/lib/agent/useSessionRestore.pbt.test.ts` を新規作成する
    - **Property 8: 過去セッション復元の解決関数**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.6, 5.7, 5.8**
    - `resolved` / `missing_connection`（`data===null, error===null`) / `lookup_error`（`error!==null`）の3種のモック化されたルックアップ結果を生成し、常にこの3状態のいずれか1つに正確に分類され、`resolved` の場合のみ送信許可（`awsProfileName`/`displayName`/`awsAccountId`/`awsRegion`/`operationScope` を含む）となることを `fast-check` で検証する（最低100イテレーション）

- [x] 14. Checkpoint - フロントエンド純粋関数の lint / 型チェック
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。フロントエンド変更は lint + 型チェックを最優先する（testing 方針）。純粋関数群（`connectionResolver.ts` / `copilotProperties.ts` / `connectionValidation.ts` / `connectionSelectability.ts` / `useSessionRestore.ts`）と PBT がすべて通ることを確認する。

- [x] 15. フロントエンド: コンポーネントのフィールド参照更新
  - [x] 15.1 `src/components/agent/ConnectionForm.tsx` を更新する
    - `gatewayUrl` の `<input type="url">` フィールドを削除し、`awsProfileName` の `<input type="text">`（`maxLength=256`、必須）を追加する
    - `ConnectionFormValues.gatewayUrl` を `awsProfileName` に置換し、バリデーション呼び出し（`connectionValidation.ts` 更新版）とインラインエラー表示を新フィールドに合わせる
    - _Requirements: 6.1, 6.2_

  - [x] 15.2 `src/components/agent/ConnectionCatalogManager.tsx` を更新する
    - `EditTarget.gatewayUrl` / `ConnectionCreateInput.gatewayUrl` / `ConnectionUpdateInput.gatewayUrl` を `awsProfileName` に置換する
    - 一覧表示の `<span>URL: {conn.gatewayUrl}</span>` を `<span>Profile: {conn.awsProfileName}</span>` に変更する
    - _Requirements: 6.5_

  - [x] 15.3 `src/components/agent/ConnectionList.tsx` を更新する
    - `Connection` インターフェースの `gatewayUrl` を `awsProfileName` に置換する（表示フィールド自体に変更はない。`gatewayUrl` は元々表示していなかった）
    - _Requirements: 3.1, 3.2_

  - [x] 15.4 `src/components/agent/ProfileSelector.tsx` を更新する
    - `connectionSelectability.ts` の `isConnectionSelectable` を使用し、`awsProfileName` が空/空白の Connection をリスト内で選択不可（クリック無効化 + 視覚的な非活性表示）として扱う（Requirement 8.2）
    - _Requirements: 8.2_

  - [x] 15.5 `src/lib/agent/useConnectionAdmin.ts` を更新する
    - `ConnectionCreateInput.gatewayUrl` / `ConnectionUpdateInput.gatewayUrl` を `awsProfileName` に置換する（CRUD ロジック自体は変更しない）
    - _Requirements: 3.1_

- [x] 16. フロントエンド: ページ統合（セッション復元 UI 結線）
  - [x] 16.1 `src/app/page.tsx` を更新する
    - `sessionState` に `awsProfileName` を保持できるよう型を拡張する
    - `handleSelectSession`（サイドバーからの過去セッション選択）内で、選択された `ChatSession` の `connectionId` / `operationScope` を取得し、`useSessionRestore` の `resolveRestoredSession` を呼び出す
    - `resolved` の場合のみ `sessionState`（`connectionId`, `operationScope`, `awsProfileName`）を更新し、新しい `threadId`（セッションID）+ properties を `CopilotProvider` に伝播する
    - `missing_connection` の場合は送信をブロックし、`SessionHeader` に「元の接続が見つかりません」という欠落インジケーターを表示する（displayName/awsAccountId/awsRegion の代わり）
    - `lookup_error` の場合は送信をブロックし、エラーメッセージを表示する（再試行 or 新規セッションまでブロック）
    - `CopilotProvider` への `gatewayUrl` prop 渡しを `awsProfileName={selectedConnection?.awsProfileName}` に更新する
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 17. Final Checkpoint - 全体統合の lint / 型チェック / スモーク確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。フロントエンドは lint + 型チェック（`gatewayUrl`/`endedAt` の残存参照がないことを確認）、エージェントはスモークテスト + インポート確認を実施する。フロントエンドとエージェントの結合テストは Amplify Hosting のデプロイ環境でのみ可能であり、本チェックポイントの対象外である（testing 方針）。

## Notes

- `*` 付きサブタスクは任意（テスト）。実装エージェントは `*` 付きを実装せず、`*` なしを実装する。
- 各タスクは要件番号と設計プロパティ（**Property 1〜11**）を参照する。**Property 7（カタログ認可）** と **Property 10（管理者向け UI ゲート）** はフィールド名変更の影響を受けないため、既存実装（`catalogAuthorization.ts` / `accessGates.ts` とその PBT）を再利用し、新規タスクは設けない。
- PBT ライブラリ: TS = `fast-check`、Python = `hypothesis`。各 PBT は最低 100 イテレーション、タグ `Feature: multi-account-mcp-access, Property {n}: {description}`、1 プロパティ = 1 PBT。
- 影響レイヤー: `amplify/`（データモデル）・`agents/`（エージェント）・`src/`（API Route + フロントエンド）。レイヤー責務分離（structure ルール）を厳守する。
- 本計画はコーディングタスクのみを対象とする。Requirement 7（Runtime 実行環境への AWS 認証情報プロビジョニング）に関する運用文書化・実際の認証情報配置・デプロイ設定は、コード編集だけでは完結しない運用者専用タスクとして下記に分離する。

### 運用者 / デプロイ専用タスク（O 系・非コード・本計画の対象外・高感度）

以下はコーディングタスクではなく、運用者が手動で実施する。設計 F1・F2 に対応し、Requirement 7・8 の一部を満たす（PR レビュー必須）。

- **O1. Credential_Provisioning_Mechanism の文書化**: 各 `AWS_Profile_Name` に対応する AWS 認証情報を Runtime 実行環境に配置する方法（AWS CLI プロファイルファイル、環境変数ベースの認証情報セット等）を運用ドキュメントに明文化する。長期認証情報をコード/データモデル/バージョン管理に保存しないことを明記する（**高感度 / F1**、_Requirements 7.1, 7.2_）。
- **O2. `AWS_MCP_PROXY_PROFILES` 環境変数の設定**: Connection カタログの `awsProfileName` 一覧（タスク 3.1 の `build_proxy_profiles_env` の出力）を Runtime デプロイ設定に反映する（**高感度 / F2**、_Requirements 1.3_）。
- **O3. 認証情報の再現性確認**: Runtime 実行環境の再構築・再デプロイ後も、既存の全 `AWS_Profile_Name` が追加の手動操作なしに解決可能であることを確認する（_Requirements 7.3_）。
- **O4. エージェントデプロイ**: `agentcore deploy` でエージェントコード（`main.py`, `gateway/client.py`, `context/session_context.py`, `profile/injection.py`, `prompts/system.py`）をデプロイする。
- **O5. Amplify / フロントエンドデプロイ**: スキーマ変更（タスク1.1）とフロントエンド変更を Amplify Hosting へデプロイする。
- **O6. カタログ再登録**: 管理者が Connection カタログを `awsProfileName` 付きで作成・更新する（Migration Plan 選択肢 A: 手動データ移行 / 選択肢 B: 全面再登録、いずれか運用者判断）（_Requirements 8.1, 8.2_）。
- **O7. プロファイル解決の実地確認**: 各 `awsProfileName` について readonly な `call_aws`（例: `sts get-caller-identity`）を実施し、エージェントが実際に解決できることを確認する（_Requirements 7.4_）。

デプロイ順序（推奨、design.md Migration Plan 準拠）: O1/O2（認証情報プロビジョニング）→ O4（エージェントデプロイ）→ O5（Amplify/フロントエンドデプロイ）→ O6/O7（カタログ再登録・解決確認）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "6.1", "9.1", "10.1", "11.1", "12.1", "13.1"] },
    { "id": 1, "tasks": ["2.2", "3.2", "4.2", "5.1", "5.3", "6.2", "9.2", "9.3", "10.2", "10.3", "11.2", "12.2", "13.2", "15.1", "15.3", "15.5"] },
    { "id": 2, "tasks": ["5.2", "7.1", "15.2", "15.4"] },
    { "id": 3, "tasks": ["16.1"] }
  ]
}
```
