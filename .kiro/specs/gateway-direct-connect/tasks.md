# Implementation Plan: Gateway Direct Connect（移行）

## Overview

本実装計画は、既に sandbox で動作している「aws-mcp-gateway-agent」機能を、新アーキテクチャ（**アカウントごとに 1 Gateway + 各 Gateway に 1 AWS MCP ターゲット、`GATEWAY_IAM_ROLE` 直接 SigV4 接続**）へ移行（リワーク）するためのコーディングタスクである。**ゼロからの新規構築ではなく、既存の動作するコードを差分修正する**点が本計画の前提である。

主要な移行差分:

| 観点 | 旧（実装済み） | 新（本計画で移行） |
|------|----------------|--------------------|
| データモデル | `gatewayTargetName` | `gatewayUrl`（HTTPS URL） |
| セッションヘッダー | `X-Gateway-Target` | `X-Gateway-Url` |
| エージェント接続先 | 固定 `GATEWAY_URL` 環境変数 | セッションごとに動的（`X-Gateway-Url`） |
| ツール分離 | プレフィックス `<target>___` 絞り込み | 単一ターゲットのため絞り込み廃止 |
| スコープ verb 判定 | `TARGET_SEPARATOR` で suffix 抽出 | ツール名全体で判定（プレフィックス非依存） |

実装言語（既存踏襲）:
- フロントエンド / API Route: **TypeScript**（プロパティテスト = `fast-check`）
- エージェント: **Python 3.13**（プロパティテスト = `hypothesis`）

順序方針: データモデル/純粋ロジックの基盤移行を先に行い、エージェントのリファクタ（target_filter 廃止・scope 脱依存）、API Route ヘッダー更新、UI フィールド更新、結線・統合を後に行う。各プロパティテストは最低 100 イテレーション、タグ `Feature: gateway-direct-connect, Property {n}: {description}` を付し、1 プロパティ = 1 PBT とする。

> 注（旧 Property の廃止）: 旧 spec の「Property 2: セッションターゲットによるツール制限（`<target>___` プレフィックス絞り込み）」は新アーキテクチャでは不要のため**廃止**する。これに伴い `gateway/target_filter.py` と関連テスト（`test_target_filter.py` / `test_target_filter_pbt.py`）を削除する。本計画のプロパティは設計の **14 プロパティ**を参照する。

### 高感度タスク（実装フェーズでレビュー必須・security / repo-workflow ルール）

設計の F1〜F6 に対応する。コード変更だけでは完結しない IAM / デプロイ / 認証経路の影響を含むため、PR レビューで明示確認する。

- **F5 / 1.x** Connection データモデルの `gatewayTargetName` → `gatewayUrl` フィールド変更（破壊的スキーマ変更・既存レコード移行）
- **F3** Amplify Data 認可モード（userPool）・ADMINS 書込認可・管理者のみ作成 override の維持
- **F4 / 3.x** API Route の認証ゲート・サーバーサイド Data 読取経路の維持
- **F1 / F2 / O 系** Gateway サービスロール権限、リソースベースポリシー、クロスアカウント IAM（**運用者タスク**・コーディング対象外）

---

## Tasks

- [x] 1. Amplify バックエンド: データモデル移行（gatewayTargetName → gatewayUrl）
  - [x] 1.1 Connection モデルの `gatewayTargetName` を `gatewayUrl` に変更
    - `amplify/data/resource.ts` の Connection モデルで `gatewayTargetName: a.string().required()` を `gatewayUrl: a.string().required()` に置き換える（Gateway MCP エンドポイント URL / HTTPS）
    - 既存の認可（`allow.group("ADMINS")` + `allow.authenticated().to(["read"])`）と `defaultAuthorizationMode: "userPool"`、ChatSession（`allow.owner()`）は**維持**する
    - **高感度（F5・破壊的スキーマ変更）**: フィールド名変更は破壊的変更。sandbox では再作成、既存 Connection レコードは再登録 or マイグレーションが必要な旨をコードコメントと PR 説明に明記する。デプロイ・設定への影響（既存カタログデータの移行）を記載する
    - _Requirements: 4.1, 12.1_

- [x] 2. エージェント: 単一ターゲット化リファクタ（Python 3.13）
  - [x] 2.1 セッションコンテキストを gateway_url / X-Gateway-Url に移行
    - `agents/app/AWS_MCP_Agent/context/session_context.py` の `SessionContext.gateway_target` を `gateway_url` にリネームし、抽出関数のヘッダー参照を `X-Gateway-Target` → `X-Gateway-Url` に変更する
    - スコープ未指定時に readonly へ解決するデフォルト挙動は**維持**する
    - _Requirements: 12.2, 12.3, 3.1_

  - [x] 2.2 セッションコンテキスト抽出のユニットテスト更新
    - `agents/app/AWS_MCP_Agent/context/test_session_context.py` を `X-Gateway-Url` → `gateway_url` マッピングに更新（旧 `X-Gateway-Target` 参照を除去）
    - _Requirements: 12.3_

  - [x] 2.3 ターゲット絞り込みモジュールを削除
    - `agents/app/AWS_MCP_Agent/gateway/target_filter.py` を削除する（単一ターゲット Gateway のためプレフィックス絞り込み不要）
    - 関連テスト `gateway/test_target_filter.py` および `gateway/test_target_filter_pbt.py`（旧 Property 2）を削除する
    - `gateway/` 配下の他モジュールから `target_filter` への import を除去する
    - _Requirements: 12.4_

  - [x] 2.4 スコープ強制を target_filter 非依存に修正
    - `agents/app/AWS_MCP_Agent/scope/enforcement.py` から `target_filter.TARGET_SEPARATOR` への依存を取り除き、verb 判定をツール名**全体**に対して行うよう変更する（プレフィックス分離なし）
    - readonly は write 分類を拒否、readwrite/admin は許可、判定はチャット本文に非依存という規則は**維持**する。構造化ログでのスコープ拒否観測も維持する
    - _Requirements: 3.7, 7.2, 7.3_

  - [x] 2.5 操作スコープ強制のプロパティテスト更新
    - **Feature: gateway-direct-connect, Property 2: 操作スコープの強制**
    - **Validates: Requirements 3.7, 7.2, 7.3**
    - `scope/test_enforcement_pbt.py` を、プレフィックスなしのツール名集合で生成するよう更新し、規則どおりの許可/拒否・本文非依存を検証（`hypothesis`、最低 100 iter）
    - _Requirements: 3.7, 7.2, 7.3_

  - [x] 2.6 エラー分類の識別子をツール名ベースに修正
    - `agents/app/AWS_MCP_Agent/gateway/error_classification.py` で、エラー識別子を旧 `gateway_target` 名から、タイムアウト時の対象**ツール名**を含む形に修正する（接続失敗/DNS/auth/timeout の種別分類は維持）
    - _Requirements: 1.4, 1.5_

  - [x] 2.7 エラー分類のプロパティテスト更新
    - **Feature: gateway-direct-connect, Property 1: エラーの分類と識別子の付与**
    - **Validates: Requirements 1.4, 1.5**
    - `gateway/test_error_classification_pbt.py` を新識別子（timeout 時のツール名）に合わせて更新（`hypothesis`、最低 100 iter）
    - _Requirements: 1.4, 1.5_

  - [x] 2.8 スコープ拒否メッセージのプロパティテスト維持確認
    - **Feature: gateway-direct-connect, Property 3: スコープ拒否メッセージの内容**
    - **Validates: Requirements 3.8, 7.4**
    - `scope/test_rejection_message_pbt.py` がリネーム/脱依存後も拒否操作名・スコープ制約・read-write 提案を含むことを検証（タグを `gateway-direct-connect` に更新、`hypothesis`、最低 100 iter）
    - _Requirements: 3.8, 7.4_

- [x] 3. エージェント: 動的 Gateway 接続・プロンプト・結線
  - [x] 3.1 main.py を固定 GATEWAY_URL からセッション動的接続へ移行
    - `agents/app/AWS_MCP_Agent/main.py` で、固定 `GATEWAY_URL` 環境変数の参照を撤去し、`session_context.gateway_url`（`X-Gateway-Url` 由来）で `build_gateway_client` に接続するよう変更する
    - `tools_for_target` 呼び出しを削除し、`discover_tools` の全ツールをそのまま使う
    - 一致ツールなし時の未対応応答 + 利用可能カテゴリ提示（3.5）、ツールエラーの自然言語報告 + 是正策（3.6）、スコープ強制（3.7）の結線は**維持**する
    - `gateway/client.py`（`build_gateway_client` / `discover_tools`、startup_timeout=30）は流用し変更最小とする
    - _Requirements: 3.1, 3.3, 3.4, 12.3, 12.4_

  - [x] 3.2 システムプロンプトを単一接続向けに適応
    - `agents/app/AWS_MCP_Agent/prompts/system.py` から「他ターゲットのツールを使うな」等のプレフィックス分離前提の文言を削除し、接続先（アカウント情報）と操作スコープ制約の明示に集中するよう適応する
    - _Requirements: 3.4, 3.5_

  - [x] 3.3 接続失敗・ツールエラー報告のユニットテスト更新
    - `gateway/test_error_reporting.py` を新接続フロー（`gateway_url` ベース、target_filter なし）に合わせて更新。接続失敗報告（3.2）、ツールエラーの自然言語報告 + 是正策（3.6）を検証（Gateway/MCP transport はモック）
    - _Requirements: 3.2, 3.6_

- [x] 4. Checkpoint - エージェントスモーク確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。エージェント変更はスモークテスト + インポート確認を優先（`uvicorn` または `agentcore dev` + curl で `/invocations`）。`target_filter` 削除後の import エラーがないことを確認する。

- [x] 5. API Route: ヘッダー・解決ロジックの移行
  - [x] 5.1 connectionResolver を gatewayUrl / X-Gateway-Url に移行
    - `src/lib/agent/connectionResolver.ts` の `ResolvedConnection.gatewayTargetName` を `gatewayUrl` に、`buildProxyHeaders` の `X-Gateway-Target` を `X-Gateway-Url` にリネームする
    - `validateAndExtractContext`（connectionId/operationScope 欠如検証 → 400、解決不可 → 400）は変更なしで流用する
    - `src/app/api/copilotkit/route.ts` の Connection 解決・ヘッダー付与箇所を新フィールド/ヘッダーに更新する。サーバーサイド Data 読取（認証ユーザートークン）と認証ゲート（401）は**維持**する
    - **高感度（F4・認証経路）**: API Route から Data Model を読む認可経路の維持を PR で確認する
    - _Requirements: 6.5, 8.3, 8.6, 12.2_

  - [x] 5.2 ヘッダー伝播のプロパティテスト更新
    - **Feature: gateway-direct-connect, Property 6: セッションコンテキストのヘッダー伝播**
    - **Validates: Requirements 6.5, 8.3, 8.6, 12.2**
    - `src/lib/agent/connectionResolver.pbt.test.ts` を、`X-Gateway-Url` = gatewayUrl / `X-Operation-Scope` = scope を含むことの検証に更新（`fast-check`、最低 100 iter、Data クライアントはモック）
    - _Requirements: 6.5, 8.3, 8.6, 12.2_

  - [x] 5.3 接続解決・入力検証のプロパティテスト維持確認
    - **Feature: gateway-direct-connect, Property 7: 接続の解決と入力検証**
    - **Validates: Requirements 8.1, 8.2, 8.4**
    - `src/lib/agent/connectionResolver.validation.pbt.test.ts` のタグ/参照を `gateway-direct-connect` に更新し、connectionId/scope 欠如→400・解決不可→400・解決時のみヘッダー構築を検証（`fast-check`、最低 100 iter）
    - _Requirements: 8.1, 8.2, 8.4_

  - [x] 5.4 認証ゲートのプロパティテスト維持確認
    - **Feature: gateway-direct-connect, Property 8: API Route の認証ゲート**
    - **Validates: Requirements 8.5, 10.2**
    - `src/lib/agent/authGate.pbt.test.ts` のタグを `gateway-direct-connect` に更新し、未認証は 401・プロキシせず／認証済みのみ後続を検証（`fast-check`、最低 100 iter）
    - _Requirements: 8.5, 10.2_

- [x] 6. フロントエンド: バリデーションとフィールドの移行
  - [x] 6.1 connectionValidation を gatewayUrl（HTTPS）検証に移行
    - `src/lib/agent/connectionValidation.ts` の `gatewayTargetName`（非空）検証を `gatewayUrl`（有効な HTTPS URL）検証に置き換える
    - displayName（1〜100 文字）/ awsAccountId（12 桁数値）/ awsRegion（`[a-z]+-[a-z]+-[0-9]+`）の検証と、フィールド単位エラー・送信可否判定は**維持**する
    - _Requirements: 5.5, 5.6, 12.5_

  - [x] 6.2 バリデーション + 送信ゲートのプロパティテスト更新
    - **Feature: gateway-direct-connect, Property 4: 接続フィールドのバリデーションと送信ゲート**
    - **Validates: Requirements 5.5, 5.6, 12.5**
    - `src/lib/agent/connectionValidation.pbt.test.ts` を gatewayUrl（HTTPS URL）生成を含む入力に更新し、全フィールド適合時のみ送信可・不適合はフィールド単位エラー生成を検証（`fast-check`、最低 100 iter）
    - _Requirements: 5.5, 5.6, 12.5_

- [x] 7. フロントエンド: コンポーネントのフィールド参照更新
  - [x] 7.1 ConnectionForm を gatewayUrl 入力に移行
    - `src/components/agent/ConnectionForm.tsx` の `gatewayTargetName` 入力フィールドを `gatewayUrl`（HTTPS URL）入力に置き換え、`connectionValidation.ts` のインラインエラー表示を新フィールドに合わせる
    - _Requirements: 5.1, 5.2, 12.5_

  - [x] 7.2 ProfileSelector / ConnectionList / ConnectionCatalogManager のフィールド参照を更新
    - `src/components/agent/ProfileSelector.tsx`、`ConnectionList.tsx`、`ConnectionCatalogManager.tsx` の `gatewayTargetName` 参照を `gatewayUrl` に更新する（一覧表示は displayName / awsAccountId / awsRegion のままで可、内部参照のみ修正）
    - 既存のユーザーフロー（login → 接続選択 → チャット）は**維持**する
    - _Requirements: 5.4, 9.2, 12.5, 12.6_

  - [x] 7.3 CopilotProvider / SessionChat / SessionHeader の整合性確認と修正
    - `src/lib/agent/CopilotProvider.tsx`（body の connectionId/operationScope 送信）、`src/components/agent/SessionChat.tsx`、`SessionHeader.tsx` が新フィールド（gatewayUrl）と矛盾しないことを確認し、`gatewayTargetName` 参照が残っていれば `gatewayUrl` に修正する
    - _Requirements: 6.3, 9.3, 12.6_

- [x] 8. Checkpoint - フロントエンド lint / 型チェック
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。フロントエンド変更は lint + 型チェックを最優先（testing ルール）。`gatewayTargetName` の残存参照がないことを型チェックで確認する。

## Notes

- 本計画は**移行（リワーク）**であり、多くのタスクは「create」ではなく「modify / update / rename / remove」である。
- `*` 付きサブタスクは任意（テスト）。実装エージェントは `*` 付きを実装せず、`*` なしを実装する。
- 各タスクは要件番号と設計プロパティ（**14 プロパティ**）を参照（トレーサビリティ）。旧 Property 2「ターゲットプレフィックス絞り込み」は廃止し、関連コード/テストを削除する（タスク 2.3）。
- 変更のないプロパティ（Property 5 カタログ認可 / 9 チャットアクセスゲート / 10 管理者 UI ゲート / 11 セッション束縛不変性 / 12 スコープ永続化 / 13 スコープデフォルト / 14 参照整合性）は、本移行でフィールド名/ヘッダーの影響を受けないため再実装タスクを設けない。既存テスト（`accessGates.*`、`catalogAuthorization.*`、`scopeRoundTrip.*`、`connectionIntegrity.*`、`context/test_scope_default_pbt.py`）はそのまま有効。
- PBT ライブラリ: TS = `fast-check`、Python = `hypothesis`。各 PBT は最低 100 イテレーション、タグ `Feature: gateway-direct-connect, Property {n}: {description}`、1 プロパティ = 1 PBT。
- 影響レイヤー: `amplify/`（データモデル）・`agents/`（エージェント）・`src/`（API Route + フロントエンド）。レイヤー責務分離（structure ルール）を厳守する。

### 運用者 / デプロイ専用タスク（O 系・非コード・本計画の対象外）

以下はコード編集だけでは完結せず、運用者が手動で実施する。コーディングタスクには含めない（設計 F1・F2・F6、_Requirements 11.4, 11.5, 2.1, 2.4_）。

- **O1. アカウント別 Gateway のデプロイ**: 対象 AWS アカウント / リージョンに Gateway をデプロイし、`mcpServer` ターゲット（endpoint `https://aws-mcp.<region>.api.aws/mcp`）+ `GATEWAY_IAM_ROLE`（`iamCredentialProvider: { service: "execute-api", region }`）を構成する（**高感度 / F1**、_Requirements 11.1, 11.2_）。
- **O2. Gateway サービスロール IAM 権限**: Gateway サービスロールに `execute-api:Invoke`（AWS MCP エンドポイント）と操作対象リソース権限を最小権限で付与する（**高感度 / F1**、_Requirements 1.2, 11.3_）。
- **O3. リソースベースポリシー（クロスアカウント）**: 対象アカウント Gateway に、中央 Runtime 実行ロール ARN へ `bedrock-agentcore:InvokeGateway` を許可するポリシーを付与する（許可先 ARN を限定、ワイルドカード回避）（**高感度 / F2**、_Requirements 2.1, 2.4_）。
- **O4. AgentCore Runtime デプロイ**: `agentcore deploy`（Amplify ビルドは Docker 非対応のため別デプロイ）。中央 Runtime ロールが各 Gateway を `InvokeGateway` できることを確認する（_Requirements 2.2, 2.3_）。
- **O5. カタログエントリ作成**: 新 Gateway デプロイ後、管理者 UI で Connection を作成し `gatewayUrl` に新 Gateway の MCP URL を登録する（_Requirements 11.5_）。

### 統合 / スモークテスト（デプロイ環境が必要・非コード前提、参考）

- Gateway の直接 SigV4 接続・ルーティング・タイムアウト（1.1〜1.3, 1.6）、クロスアカウント接続（2.2, 2.3）、エージェント起動接続・ツール発見（3.1, 3.3）、per-session 接続ライフサイクル（12.4）: AgentCore デプロイ後の統合/スモーク。
- Gateway ターゲット構成・サービスロール権限・リソースポリシー（11.1〜11.3, 2.1, 2.4）・セルフサインアップ無効化（10.1）: 設定検証。
- フロントエンド↔エージェント結合: Amplify Hosting デプロイ環境でのみ実施可能（ローカルは SigV4 + コンピューティングロール必須のため不可、testing ルール）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3", "2.6", "5.1", "6.1"] },
    { "id": 1, "tasks": ["2.2", "2.4", "2.7", "5.2", "5.3", "5.4", "6.2", "7.1"] },
    { "id": 2, "tasks": ["2.5", "2.8", "3.1", "3.2", "7.2", "7.3"] },
    { "id": 3, "tasks": ["3.3"] }
  ]
}
```
