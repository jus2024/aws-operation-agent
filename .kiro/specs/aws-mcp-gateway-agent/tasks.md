# Implementation Plan: AWS MCP Gateway Agent

## Overview

本実装計画は、設計（design.md）と要件（requirements.md）を、コード生成 LLM が増分的に実行できる一連のコーディングタスクに変換したものである。各タスクは前のタスクの成果に積み上がり、最終的に各レイヤーを結線する。レイヤーの責務分離ルール（`src/` = Web、`agents/` = エージェント、`amplify/` = バックエンド）を厳守する。

実装言語:
- フロントエンド / API Route: **TypeScript**（プロパティテスト = `fast-check`）
- エージェント: **Python 3.13**（プロパティテスト = `hypothesis`）

順序方針: バックエンド/データと純粋ロジックの基盤を先に作り、UI 結線と統合を後に行う。各プロパティテストは最低 100 イテレーション、タグ `Feature: aws-mcp-gateway-agent, Property {n}: {description}` を付し、1 プロパティ = 1 PBT とする。

### 高感度タスク（実装フェーズでレビュー必須・security / repo-workflow ルール）

- **1.x** Amplify Data 認可モード変更（apiKey → userPool）、Connection の ADMINS 書き込み認可（認証・認可変更）
- **1.4** Cognito セルフサインアップ無効化 `allowAdminCreateUserOnly = true`（認証変更 / F2）
- **3.x / 4.x** API Route の認証ゲート・サーバーサイド Data アクセス（認証経路 / F4）
- **運用者タスク（O 系）** Gateway ターゲットのプロビジョニング、コンピューティングロールへの IAM 権限付与（IAM / デプロイ変更 / F3・F4・F5）

> これらはコード変更だけでは完結しない IAM / デプロイ影響を含むため、PR レビューで明示的に確認すること。

---

## Tasks

- [x] 1. Amplify バックエンド: データモデルと認証の拡張
  - [x] 1.1 Connection / ChatSession データモデルを定義し認可モードを userPool に変更
    - `amplify/data/resource.ts` に Connection モデル（displayName 必須 / awsAccountId 必須 / awsRegion 必須 / gatewayTargetName 必須 / description 任意）を追加
    - ChatSession モデル（ownerUserId 必須 / connectionId 必須 / operationScope enum["readonly","readwrite","admin"] / startedAt / endedAt 任意）を追加
    - Connection 認可: `allow.group("ADMINS")` + `allow.authenticated().to(["read"])`、ChatSession 認可: `allow.owner()`
    - `defaultAuthorizationMode` を `apiKey` → `userPool` に変更
    - **高感度（認証・認可変更）**: 既存サンプル Todo（apiKey）は userPool 化で動作しなくなる点をコード内コメントと PR 説明に明記（F2）。フロントエンドの認証必須化が前提
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 9.3, 9.4_

  - [x] 1.2 defineAuth に ADMINS グループを追加
    - `amplify/auth/resource.ts` の `defineAuth` に `groups: ["ADMINS"]` を追加
    - _Requirements: 9.3_

  - [x] 1.3 backend.ts を defineBackend の戻り値ベースに更新
    - `amplify/backend.ts` を `const backend = defineBackend({ auth, data })` 形式に変更（後続の CFN override の土台）
    - _Requirements: 9.1_

  - [x] 1.4 Cognito セルフサインアップ無効化の CFN override を追加
    - `amplify/backend.ts` で `backend.auth.resources.cfnResources.cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true }` を設定
    - **高感度（認証変更 / F2）**: 管理者のみユーザー作成可能になる影響を PR 説明に明記
    - _Requirements: 9.1_

  - [x] 1.5 カタログ認可決定のプロパティテスト（sandbox/統合）
    - **Property 6: カタログ認可の決定**
    - **Validates: Requirements 3.4, 6.3, 9.3, 9.4**
    - sandbox デプロイ上で（グループ集合, 操作種別）の組に対し read=認証ユーザー許可 / write=ADMINS のみ許可 / 非管理者 write 拒否を検証（`hypothesis` or `fast-check` で入力生成、Data クライアント経由で認可結果を確認）
    - _Requirements: 3.4, 6.3, 9.3, 9.4_

  - [x] 1.6 スコープ永続化ラウンドトリップのプロパティテスト（sandbox/統合）
    - **Property 13: スコープ永続化のラウンドトリップ**
    - **Validates: Requirements 5.5**
    - 有効なスコープ値（readonly/readwrite/admin）で ChatSession を保存→読出し、同一スコープが得られることを検証
    - _Requirements: 5.5_

  - [x] 1.7 参照整合性のプロパティテスト（sandbox/統合）
    - **Property 15: 参照整合性**
    - **Validates: Requirements 6.6**
    - N>0 件の ChatSession が参照する Connection の削除が拒否されることを検証（アプリ層の削除前参照チェック）
    - _Requirements: 6.6_

  - [x] 1.8 ChatSession owner 認可の統合テスト
    - 別ユーザーが他者の ChatSession を read/update/delete できないことを検証（クロスユーザーアクセス拒否）
    - _Requirements: 6.4_

- [x] 2. Amplify バックエンド: 参照整合性ロジック（アプリ層）
  - [x] 2.1 Connection 削除前の参照チェックロジックを実装
    - Connection 削除時に参照中の ChatSession を検索し、参照があれば削除を拒否する純粋関数 / ヘルパーを `amplify/` 配下または共有 lib に実装（DB レベル外部キーがないため (a) 参照中削除拒否を既定）
    - _Requirements: 6.6_

  - [x] 2.2 参照チェックロジックのユニットテスト
    - 参照あり=拒否 / 参照なし=許可、空集合・複数参照のエッジケースを検証
    - _Requirements: 6.6_

- [x] 3. Checkpoint - バックエンド型チェック
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。Amplify 変更はデプロイ・設定への影響（認証モード変更 / Todo 影響 / 認証必須化）を記載する。

- [x] 4. エージェント: 純粋ロジックモジュール（Python 3.13）
  - [x] 4.1 agentcore.json の runtimeVersion を修正
    - `agents/agentcore/agentcore.json` の `runtimeVersion` を `PYTHON_3_14` → `PYTHON_3_13` に変更（F1、ag-ui-strands 非対応のため）
    - _Requirements: 2.1_

  - [x] 4.2 セッションコンテキスト抽出モジュールを実装
    - `agents/app/AWS_MCP_Agent/context/session_context.py` に `SessionContext`（gateway_target / operation_scope）と、ヘッダー（`X-Gateway-Target` / `X-Operation-Scope`）からの抽出関数を実装
    - スコープ未指定時は readonly に解決（デフォルト）
    - _Requirements: 4.5, 7.3, 7.6, 5.6_

  - [x] 4.3 操作スコープのデフォルト解決プロパティテスト
    - **Property 14: 操作スコープのデフォルト**
    - **Validates: Requirements 5.6**
    - スコープ未指定の入力に対し解決結果が常に readonly であることを検証（`hypothesis`）
    - _Requirements: 5.6_

  - [x] 4.4 ターゲット絞り込みモジュールを実装
    - `agents/app/AWS_MCP_Agent/gateway/target_filter.py` に `tools_for_target(all_tools, target_name)` と `is_tool_in_target(tool_name, target_name)` を実装（プレフィックス `<target>___`）
    - _Requirements: 2.3_

  - [x] 4.5 セッションターゲットによるツール制限のプロパティテスト
    - **Property 2: セッションターゲットによるツール制限**
    - **Validates: Requirements 2.3**
    - 任意の発見済みツール集合とターゲット名に対し、許可されるのはプレフィックス一致ツールのみで他ターゲットツールが全除外されることを検証（`hypothesis`）
    - _Requirements: 2.3_

  - [x] 4.6 操作スコープ強制モジュールを実装
    - `agents/app/AWS_MCP_Agent/scope/enforcement.py` に `is_write_tool(tool_name)` / `is_allowed(tool_name, scope)` を実装（readonly は write 分類を拒否、readwrite/admin は許可、判定はチャット本文に非依存）
    - 構造化ログでスコープ拒否を観測可能にする（strands-agent ルール）
    - _Requirements: 2.7, 5.2, 5.3_

  - [x] 4.7 操作スコープ強制のプロパティテスト
    - **Property 3: 操作スコープの強制**
    - **Validates: Requirements 2.7, 5.2, 5.3**
    - 任意の（ツール, スコープ）組で規則どおりの許可/拒否を返し、判定がメッセージ本文に依存しないことを検証（`hypothesis`）
    - _Requirements: 2.7, 5.2, 5.3_

  - [x] 4.8 スコープ拒否メッセージ生成を実装
    - `scope/enforcement.py`（または近接モジュール）に、拒否操作名・現在のスコープ制約・read-write 新規セッション提案を含むメッセージ生成関数を実装
    - _Requirements: 2.8, 5.4_

  - [x] 4.9 スコープ拒否メッセージのプロパティテスト
    - **Property 4: スコープ拒否メッセージの内容**
    - **Validates: Requirements 2.8, 5.4**
    - 任意の拒否 write ツールに対し、生成メッセージが操作名・スコープ制約・read-write 提案を含むことを検証（`hypothesis`）
    - _Requirements: 2.8, 5.4_

  - [x] 4.10 Gateway / MCP エラー分類モジュールを実装
    - Gateway からの失敗（timeout / connection refused / DNS / authentication）を定義済み種別に分類し、Gateway_Target 名（timeout の場合はツール名も）を含むエラーを生成する関数を実装（`gateway/` 配下）
    - 構造化ログで失敗を観測可能にする
    - _Requirements: 1.6, 1.7_

  - [x] 4.11 エラー分類のプロパティテスト
    - **Property 1: エラーの分類と識別子の付与**
    - **Validates: Requirements 1.6, 1.7**
    - 任意の失敗入力に対し、定義済み種別に分類され Gateway_Target 名を含み、timeout 時はツール名も含むことを検証（`hypothesis`）
    - _Requirements: 1.6, 1.7_

- [x] 5. エージェント: Gateway 接続・プロンプト・結線
  - [x] 5.1 Gateway MCP クライアントモジュールを実装
    - `agents/app/AWS_MCP_Agent/gateway/client.py` に `build_gateway_client(gateway_url, auth_token)`（Strands `MCPClient` + `streamablehttp_client`、`startup_timeout=30`）と全ツール発見（`list_tools_sync`）を実装
    - 接続失敗時はログ出力 + 到達不能エラー報告経路を用意（2.2）
    - _Requirements: 2.1, 2.2_

  - [x] 5.2 システムプロンプトモジュールを実装
    - `agents/app/AWS_MCP_Agent/prompts/system.py` に、アクティブ接続（Gateway ターゲット）と操作スコープ・利用可能ツールカテゴリを動的に埋め込むプロンプト生成を実装（スコープ外/他ターゲット使用を試みない指示）
    - _Requirements: 2.4, 2.5_

  - [x] 5.3 main.py をエージェント組み立てに更新
    - `agents/app/AWS_MCP_Agent/main.py` のサンプル `add_numbers` を撤去し、Gateway クライアント・ターゲット絞り込み・スコープ強制・セッションコンテキスト・システムプロンプトを結線
    - 一致ツールなし時の未対応応答 + 利用可能カテゴリ提示（2.5）、ツールエラーの自然言語報告 + 是正策（2.6）を組み込む
    - Memory セッション（`X-Amzn-Bedrock-AgentCore-Runtime-User-Id` = Cognito sub / Session-Id）の既存活用を維持
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 5.4 接続失敗・ツールエラー報告のユニットテスト
    - 接続失敗の報告（2.2）、ツール呼び出しエラーの自然言語報告 + 是正策 1 つ以上（2.6）を検証（Gateway/MCP transport はモック）
    - _Requirements: 2.2, 2.6_

  - [x] 5.5 agentcore.json に Gateway マルチターゲット構成を追加（設定タスク）
    - `agents/agentcore/agentcore.json` の `agentCoreGateways` に集約 Gateway（`name`, `targets` 配列の `mcpServer` ターゲット雛形）を定義
    - 注: 実体の Gateway ターゲットのプロビジョニング / プロキシホスティングは運用者デプロイタスク（O 系参照）。本タスクは設定記述のみ
    - _Requirements: 1.1, 1.2, 1.3, 3.7_

- [x] 6. Checkpoint - エージェントスモーク確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。エージェント変更はスモークテスト + インポート確認を優先（`uvicorn` / `agentcore dev` + curl で `/invocations`）。

- [x] 7. API Route: 接続解決とコンテキスト伝播
  - [x] 7.1 リクエスト解析・入力検証・接続解決の純粋ロジックを実装
    - `src/app/api/copilotkit/route.ts`（または近接の `src/lib/agent/` ヘルパー）に、ボディからの `connectionId` / `operationScope` 抽出、欠如時 400、カタログ解決不可時 400、解決時にヘッダー（`X-Gateway-Target` = gatewayTargetName / `X-Operation-Scope` = scope）を構築するロジックを実装
    - サーバーサイド Data アクセス（認証ユーザートークンで Connection を read）を組み込む
    - **高感度（認証経路 / F4）**: API Route から Data Model を読む認可経路を PR で確認
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_

  - [x] 7.2 認証ゲート（401）を route.ts に組み込む
    - `route.ts` で未認証（有効な Cognito トークンなし）はプロキシせず 401。認証済みのみ後続処理へ（既存の Bearer チェックを正式なゲートとして整理）
    - X-Gateway-Target / X-Operation-Scope を `sigv4Fetch` 経由のリクエストヘッダーに付与（`ExperimentalEmptyAdapter` + `HttpAgent` 構成は維持）
    - _Requirements: 7.5, 9.2_

  - [x] 7.3 ヘッダー伝播のプロパティテスト
    - **Property 7: セッションコンテキストのヘッダー伝播**
    - **Validates: Requirements 4.5, 7.3, 7.6**
    - 任意の解決済み Connection とスコープに対し、`X-Gateway-Target` = gatewayTargetName、`X-Operation-Scope` = scope を含むことを検証（`fast-check`、Data クライアントはモック）
    - _Requirements: 4.5, 7.3, 7.6_

  - [x] 7.4 接続解決・入力検証のプロパティテスト
    - **Property 8: 接続の解決と入力検証**
    - **Validates: Requirements 7.2, 7.4**
    - connectionId/scope 欠如→400、解決不可→400、解決時のみヘッダー構築を検証（`fast-check`）
    - _Requirements: 7.2, 7.4_

  - [x] 7.5 認証ゲートのプロパティテスト
    - **Property 9: API Route の認証ゲート**
    - **Validates: Requirements 7.5, 9.2**
    - 未認証は 401 でプロキシせず、認証済みのみ後続へ進むことを検証（`fast-check`）
    - _Requirements: 7.5, 9.2_

- [x] 8. フロントエンド: 純粋ロジックとフック
  - [x] 8.1 接続バリデーション純粋関数を実装
    - `src/lib/agent/connectionValidation.ts` に displayName（1〜100 文字）/ awsAccountId（12 桁数値）/ awsRegion（`[a-z]+-[a-z]+-[0-9]+`）/ gatewayTargetName（非空）の検証と、フィールド単位エラー・送信可否判定を実装
    - _Requirements: 3.5, 3.6_

  - [x] 8.2 バリデーション + 送信ゲートのプロパティテスト
    - **Property 5: 接続フィールドのバリデーションと送信ゲート**
    - **Validates: Requirements 3.5, 3.6**
    - 任意の接続入力に対し、全フィールド適合時のみ送信可、不適合時は送信阻止 + フィールド単位エラー生成を検証（`fast-check`）
    - _Requirements: 3.5, 3.6_

  - [x] 8.3 Cognito グループ判定フックを実装
    - `src/lib/agent/useIsAdmin.ts` に Cognito トークンの `cognito:groups` に `ADMINS` を含むか判定するフックを実装
    - _Requirements: 8.6, 8.7, 9.5_

  - [x] 8.4 カタログ読み取り / CRUD フックを実装
    - `src/lib/agent/useConnectionCatalog.ts`（全認証ユーザー read）、`src/lib/agent/useConnectionAdmin.ts`（ADMINS のみ create/update/delete）を実装（Amplify Data クライアント）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 8.2_

  - [x] 8.5 チャットアクセスゲート / 管理 UI ゲート / セッション束縛の純粋判定を実装
    - チャット描画可否（認証済み ∧ カタログ ≥1 件 ∧ 接続選択済み）、管理コントロール描画可否（ADMINS のみ）、セッション接続束縛の不変性（新規セッション以外で接続不変）を純粋関数 / リデューサとして `src/lib/agent/` に実装
    - _Requirements: 4.1, 4.4, 8.1, 8.5, 8.6, 8.7, 9.5_

  - [x] 8.6 チャットアクセスゲートのプロパティテスト
    - **Property 10: チャットアクセスゲート**
    - **Validates: Requirements 4.1, 8.1, 8.5**
    - 任意の（認証状態, 接続選択, カタログ件数）に対し、チャット描画/有効化が 3 条件すべて成立時に限ることを検証（`fast-check`）
    - _Requirements: 4.1, 8.1, 8.5_

  - [x] 8.7 管理者向け UI ゲートのプロパティテスト
    - **Property 11: 管理者向け UI ゲート**
    - **Validates: Requirements 8.6, 8.7, 9.5**
    - 任意のグループ集合に対し、管理コントロールが ADMINS 所属時のみ描画、非所属時は一切描画されないことを検証（`fast-check`）
    - _Requirements: 8.6, 8.7, 9.5_

  - [x] 8.8 セッション-接続束縛不変性のプロパティテスト
    - **Property 12: セッション-接続束縛の不変性**
    - **Validates: Requirements 4.4**
    - 任意のアクティブセッションで、新規セッション開始なしの接続変更操作後も束縛接続が不変であることを検証（`fast-check`）
    - _Requirements: 4.4_

- [x] 9. フロントエンド: コンポーネントと主画面結線
  - [x] 9.1 ConnectionList コンポーネントを実装
    - `src/components/agent/ConnectionList.tsx`: displayName / awsAccountId / awsRegion の一覧表示
    - _Requirements: 3.4, 8.2_

  - [x] 9.2 ConnectionForm と ConnectionCatalogManager（管理者専用）を実装
    - `src/components/agent/ConnectionForm.tsx`: 作成/編集フォーム + `connectionValidation.ts` のインラインエラー
    - `src/components/agent/ConnectionCatalogManager.tsx`: ADMINS のみの CRUD（削除は確認ダイアログ）、`useIsAdmin` false 時は一切描画しない
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 8.6, 9.5_

  - [x] 9.3 ProfileSelector コンポーネントを実装
    - `src/components/agent/ProfileSelector.tsx`: カタログ選択 + 操作スコープ選択（既定 readonly）。接続選択までチャット UI を描画しない。カタログ 0 件時は「管理者に連絡」案内
    - _Requirements: 4.1, 4.2, 5.1, 5.6, 8.5_

  - [x] 9.4 SessionHeader と SessionChat コンポーネントを実装
    - `src/components/agent/SessionHeader.tsx`: 接続の displayName / awsAccountId / region をスクロールなしで見える固定ヘッダーに表示
    - `src/components/agent/SessionChat.tsx`: セッション固定チャット（ヘッダー + CopilotChat）、New Session アクション、接続削除/コンテキスト読込失敗時のエラー表示 + 入力無効化 + 回復
    - _Requirements: 4.3, 4.4, 4.6, 8.3, 8.4, 8.8_

  - [x] 9.5 CopilotProvider を connectionId/scope 送信に拡張
    - `src/lib/agent/CopilotProvider.tsx`: リクエスト body / forwardedProps に `connectionId` と `operationScope` を載せる経路を追加（`@copilotkit/react-core/v2` 維持、Bearer 付与維持）
    - _Requirements: 4.5, 7.1_

  - [x] 9.6 page.tsx をチャット主画面に置き換え、ナビからサンプルリンク除外
    - `src/app/page.tsx`: 認証ゲート + 状態分岐（未認証 / カタログ空 / Profile 選択 / セッション中 / エラー）+ グループ判定で ProfileSelector・SessionChat・ConnectionCatalogManager を合成
    - サンプルページ（`src/app/sample/`）は参照用に残しつつナビゲーションのリンクを除外（structure ルール）
    - _Requirements: 8.1, 8.4, 8.5, 8.6, 8.7, 9.2, 9.5_

- [x] 10. Checkpoint - フロントエンド lint / 型チェック
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。フロントエンド変更は lint + 型チェックを最優先（testing ルール）。

## Notes

- `*` 付きサブタスクは任意（テスト）。実装エージェントは `*` 付きを実装せず、`*` なしを実装する。
- 各タスクは要件番号と設計プロパティを参照（トレーサビリティ）。
- プロパティテストは純粋ロジック層のみ。外部サービス配線・UI レンダリング・LLM 振る舞いには適用しない。
- PBT ライブラリ: TS = `fast-check`、Python = `hypothesis`。各 PBT は最低 100 イテレーション、タグ `Feature: aws-mcp-gateway-agent, Property {n}: {description}`、1 プロパティ = 1 PBT。

### 運用者 / デプロイ専用タスク（非コード・本計画の対象外、参考）

以下はコード編集だけでは完結せず、運用者が手動で実施する。コーディングタスクには含めない。

- **O1. Gateway ターゲットのプロビジョニング**: 接続ごとに MCP Proxy for AWS（起動時宣言プロファイル付き）を用意し、`agentcore.json` の `targets` に追記後 `agentcore deploy`（F3, F5、_Requirements 1.1, 3.7_）。
- **O2. MCP Proxy for AWS のホスティング**: 各ターゲット背後のプロキシエンドポイント（`https://<proxy-host>/mcp`）の運用。Gateway → プロキシ間認証（OAuth/None）の確定（F3）。
- **O3. AgentCore Runtime / Gateway デプロイ**: `agentcore deploy`（Amplify ビルドは Docker 非対応のため別デプロイ）。
- **O4. IAM 権限付与**: Amplify Hosting コンピューティングロールへの `bedrock-agentcore:InvokeAgentRuntime` 付与、および API Route の Data 読み取り経路（**高感度 / F4**）。

### 統合 / スモークテスト（デプロイ環境が必要・非コード前提、参考）

- Gateway 集約・ルーティング・SigV4 アウトバウンド（1.1〜1.5）: AgentCore デプロイ後の統合/スモーク。
- エージェント起動接続（2.1）: `uvicorn` / `agentcore dev` + curl で `/invocations` スモーク（ローカル）、Gateway 結合はデプロイ環境。
- フロントエンド↔エージェント結合: Amplify Hosting デプロイ環境でのみ実施可能（ローカルは SigV4 + コンピューティングロール必須のため不可、testing ルール）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "4.1", "4.2", "4.4", "8.1", "8.3"] },
    { "id": 1, "tasks": ["1.4", "1.5", "1.6", "1.7", "1.8", "2.1", "4.3", "4.5", "4.6", "4.10", "8.2", "8.4", "8.5"] },
    { "id": 2, "tasks": ["2.2", "4.7", "4.8", "4.11", "5.1", "5.2", "5.5", "7.1", "8.6", "8.7", "8.8", "9.1", "9.3"] },
    { "id": 3, "tasks": ["4.9", "5.3", "7.2", "9.2", "9.4", "9.5"] },
    { "id": 4, "tasks": ["5.4", "7.3", "7.4", "7.5", "9.6"] }
  ]
}
```
