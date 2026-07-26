# Implementation Plan: Direct Role Switching

## Overview

Connection カタログベースの Multi_Profile_Mode 方式を完全に撤去し、`BeforeToolCallEvent` フック内での直接 STS AssumeRole + 環境変数注入に置き換える。利用可能ロールはアプリケーション設定（`AGENT_ROLES` 環境変数）で定義し、ユーザーはセッション開始時にロール選択するだけで済む簡素なモデルに移行する。

**破壊的スキーマ変更**: `amplify sandbox delete` → sandbox 再作成が必要。

## Tasks

- [x] 1. Data Model 変更（Amplify スキーマ）
  - [x] 1.1 ChatSession モデルの connectionId → roleName 置換、endedAt 削除、Connection モデル完全削除
    - `amplify/data/resource.ts` を編集
    - ChatSession: `connectionId: a.id().required()` → `roleName: a.string().required()`
    - ChatSession: `endedAt` フィールド削除
    - Connection モデル定義を完全削除（authorization 含む）
    - OperationScope enum と ChatMessage モデルは維持
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1_

- [x] 2. Agent コア: ロール設定モジュール
  - [x] 2.1 `agents/app/AWS_MCP_Agent/roles/config.py` を新規作成
    - `RoleConfig` dataclass（name, display_name, role_arn, scope）
    - `load_role_configs()`: `AGENT_ROLES` 環境変数（JSON 配列）パース
    - `get_role_by_name(name)`: キャッシュ済みリストから検索
    - モジュールスコープ `ROLE_CONFIGS` キャッシュ
    - 0件 or パースエラー時は error ログ + 空リスト
    - `roles/__init__.py` 作成
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 2.2 Write property test for role config parsing round trip
    - **Property 1: Role configuration parsing round trip**
    - **Validates: Requirements 1.1**
    - hypothesis で有効な JSON 入力に対する round-trip 検証

- [x] 3. Agent コア: SessionContext 変更
  - [x] 3.1 `agents/app/AWS_MCP_Agent/context/session_context.py` を変更
    - `aws_profile_name` → `role_name` にリネーム
    - `HEADER_AWS_PROFILE` → `HEADER_ROLE_NAME = "X-Role-Name"` に変更
    - `extract_session_context`: X-Role-Name ヘッダー抽出に変更
    - role_name が Role_Config に存在しない場合は None + warning ログ
    - `roles.config` の `get_role_by_name` をインポートして検証に使用
    - _Requirements: 3.1, 3.4_

  - [ ]* 3.2 Write property test for invalid role_name resolution
    - **Property 2: Invalid role_name resolution to None**
    - **Validates: Requirements 3.4**
    - hypothesis でランダムなヘッダー値に対する role_name 解決

- [x] 4. Agent コア: BeforeToolCallEvent Hook 書き換え
  - [x] 4.1 `agents/app/AWS_MCP_Agent/roles/hook.py` を新規作成（旧 `profile/injection.py` のロジックを置換）
    - `SessionScopeAndRoleHook` クラス実装
    - スコープ強制（既存 `scope.enforcement` モジュール使用）
    - `AWS_CREDENTIAL_TOOLS` 定義（call_aws, run_script, get_presigned_url, get_tasks）
    - role_name 欠如時のツール呼び出しキャンセル
    - `get_role_by_name` で ARN 解決
    - `boto3 sts:AssumeRole` 呼び出し
    - `os.environ` への一時認証情報注入
    - STS エラー時のキャンセル + 記述的エラーメッセージ
    - `current_session_context` ContextVar をこのモジュールに移動
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.1, 8.2, 8.3_

  - [ ]* 4.2 Write property test for scope enforcement precedes AssumeRole
    - **Property 3: Scope enforcement precedes AssumeRole**
    - **Validates: Requirements 8.1**

  - [ ]* 4.3 Write property test for missing role_name cancels credential-requiring tools
    - **Property 4: Missing role_name cancels credential-requiring tools**
    - **Validates: Requirements 2.6**

  - [ ]* 4.4 Write property test for STS failure cancels tool call
    - **Property 5: STS failure cancels tool call with descriptive error**
    - **Validates: Requirements 2.4**

  - [ ]* 4.5 Write property test for environment variable injection
    - **Property 6: Environment variable injection contains all three credential fields**
    - **Validates: Requirements 2.2**

- [x] 5. Agent ワイヤリング: main.py 変更 + profile/ パッケージ削除
  - [x] 5.1 `agents/app/AWS_MCP_Agent/main.py` を変更し、旧コード削除
    - `from profile.injection import ...` → `from roles.hook import SessionScopeAndRoleHook, current_session_context`
    - ドキュメンテーション文字列を更新（Multi_Profile_Mode 参照削除）
    - `profile/` パッケージ（`injection.py`, `__init__.py`）を削除
    - _Requirements: 9.2, 9.3_

- [x] 6. AgentCore 設定変更
  - [x] 6.1 `agents/agentcore/agentcore.json` の envVars を更新
    - `AWS_MCP_PROXY_PROFILES` と `AWS_CONFIG_FILE` を削除
    - `AGENT_ROLES` 環境変数を追加（JSON 配列: admin + readonly ロール定義）
    - _Requirements: 1.1, 9.2_

  - [x] 6.2 Dockerfile から `.aws/config` コピー行を削除（存在する場合）
    - `agents/app/AWS_MCP_Agent/Dockerfile` を確認・編集
    - _Requirements: 9.2_

- [x] 7. Checkpoint - Agent 側変更の確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Frontend API: GET /api/roles エンドポイント
  - [x] 8.1 `src/app/api/roles/route.ts` を新規作成
    - `RoleInfo` 型定義（name, displayName, scope）
    - Bearer トークン認証チェック（401 Unauthorized）
    - `AGENT_ROLES` 環境変数パース（サーバーサイドのみ、roleArn 除外）
    - JSON レスポンス返却
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [ ]* 8.2 Write property test for API roles endpoint excludes roleArn
    - **Property 8: API roles endpoint excludes roleArn from response**
    - **Validates: Requirements 10.1, 10.4**
    - fast-check でランダムな AGENT_ROLES 設定に対する出力検証

- [x] 9. Frontend API: /api/copilotkit route.ts 変更
  - [x] 9.1 `src/app/api/copilotkit/route.ts` を変更
    - `connectionResolver` モジュールのインポートと使用箇所を完全削除
    - `connectionId` / `awsProfileName` のプロパティ検証を削除
    - `roleName` / `operationScope` のみをリクエストボディから抽出
    - `X-Aws-Profile` → `X-Role-Name` ヘッダーに変更
    - `_sessionHeaders` 構築ロジックを簡素化
    - _Requirements: 3.2, 3.3, 3.5, 5.4, 9.4_

- [x] 10. Frontend: Connection 関連コード削除
  - [x] 10.1 Connection 関連のコンポーネント・フック・モジュールを削除
    - `src/components/agent/ConnectionForm.tsx` 削除
    - `src/components/agent/ConnectionCatalogManager.tsx` 削除
    - `src/components/agent/ConnectionList.tsx` 削除
    - `src/lib/agent/useConnectionCatalog.ts` 削除
    - `src/lib/agent/connectionResolver.ts` 削除
    - `src/lib/agent/connectionValidation.ts` 削除
    - `src/lib/agent/useSessionRestore.ts` の Connection 解決ロジック削除/簡素化
    - `src/lib/agent/useIsAdmin.ts` 削除（ADMINS グループ判定不要化）
    - `src/components/agent/ProfileSelector.tsx` 削除
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 11. Frontend: RoleSelector コンポーネント + useRoles フック
  - [x] 11.1 `src/lib/agent/useRoles.ts` を新規作成
    - GET /api/roles を呼び出すカスタムフック
    - `RoleInfo[]` を返す（name, displayName, scope）
    - isLoading / error 状態管理
    - _Requirements: 1.4, 10.1_

  - [x] 11.2 `src/components/agent/RoleSelector.tsx` を新規作成
    - `RoleSelectorProps`: roles, isLoading, onSelectRole
    - 各ロールの displayName と scope を表示
    - ロールが1件のみの場合は自動選択してスキップ
    - _Requirements: 6.1, 6.2, 6.4, 6.5_

- [x] 12. Frontend: CopilotProvider 変更
  - [x] 12.1 `src/lib/agent/CopilotProvider.tsx` と `copilotProperties.ts` を変更
    - props: `connectionId` + `awsProfileName` → `roleName` に置換
    - `buildCopilotProperties`: roleName + operationScope のみ
    - connectionId / awsProfileName プロパティの送信を完全削除
    - _Requirements: 6.3, 9.6_

  - [ ]* 12.2 Write property test for CopilotProvider properties
    - **Property 7: CopilotProvider properties contain only roleName**
    - **Validates: Requirements 9.6**
    - fast-check でランダムな roleName に対する出力検証

- [x] 13. Frontend: page.tsx 全面改修
  - [x] 13.1 `src/app/page.tsx` を変更
    - 状態マシン簡素化: `catalog_empty` 状態削除、`profile_selection` → `role_selection` に変更
    - `useConnectionCatalog` → `useRoles` に置換
    - `ProfileSelector` → `RoleSelector` に置換
    - `ConnectionCatalogManager` / isAdmin 関連 UI の完全削除
    - `handleStartSession`: connectionId → roleName に変更
    - `sessionState`: connectionId/awsProfileName → roleName に変更
    - `CopilotProvider` の props を roleName + operationScope に変更
    - セッション作成時: connectionId → roleName で ChatSession 作成
    - セッション復元: connectionId 解決 → roleName の Role_Config 存在確認に変更
    - _Requirements: 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 13.2 Write property test for unavailable role blocks messages
    - **Property 9: ChatSession with unavailable role blocks new messages**
    - **Validates: Requirements 7.3, 1.5**

- [x] 14. Frontend: セッション管理フックの変更
  - [x] 14.1 `src/lib/agent/useChatSessions.ts` を変更
    - `createSession` の引数: `connectionId` → `roleName` に変更
    - ChatSession 作成時のフィールド名を `roleName` に変更
    - _Requirements: 4.1, 9.5_

  - [x] 14.2 `src/lib/agent/useSessionRestore.ts` を変更（または新規 `useRoleRestore.ts` 作成）
    - Connection DB lookup を削除
    - roleName の Role_Config 存在確認に置換（API 呼び出し不要、ローカル roles リスト照合）
    - 存在しない場合は「ロールが利用できません」エラー
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 15. Frontend: SessionChat ヘッダー表示の変更
  - [x] 15.1 `src/components/agent/SessionChat.tsx` / `SessionHeader.tsx` を変更
    - displayName / awsAccountId / awsRegion → role displayName + scope 表示に変更
    - connectionMissing → roleMissing に変更
    - _Requirements: 7.4, 7.5_

- [x] 16. Checkpoint - Frontend 変更の確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. 環境変数設定と最終確認
  - [x] 17.1 `.env.local` / `.env.example` に AGENT_ROLES 環境変数を追加
    - フロントエンド API Route 用の AGENT_ROLES（NEXT_PUBLIC_ なし）
    - _Requirements: 1.1, 10.1_

  - [x] 17.2 不要ファイルの最終削除確認
    - `agents/app/AWS_MCP_Agent/profile/` パッケージ全体が削除されていること
    - `src/lib/agent/connectionResolver.ts` が削除されていること
    - Connection 関連インポートがコードベースに残っていないこと（grep 検証）
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 9.2, 9.3_

- [x] 18. Final checkpoint - 全体の整合性確認
  - Ensure all tests pass, ask the user if questions arise.
  - lint（frontend: eslint + tsc、agent: ruff）が通ること
  - Connection / aws_profile / Multi_Profile_Mode への参照がコードベースに残っていないこと

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (hypothesis for Python, fast-check for TypeScript)
- **破壊的スキーマ変更**: 実装後は `amplify sandbox delete` → sandbox 再作成が必須
- Agent 側は Python 3.12+、Frontend 側は TypeScript を使用
- `profile/` パッケージの完全削除は main.py のインポート変更と同時に実施し、インポートエラーを防ぐ

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "6.1"] },
    { "id": 1, "tasks": ["2.2", "3.1", "6.2"] },
    { "id": 2, "tasks": ["3.2", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "4.5", "5.1"] },
    { "id": 4, "tasks": ["8.1", "9.1", "10.1"] },
    { "id": 5, "tasks": ["8.2", "11.1", "11.2", "12.1"] },
    { "id": 6, "tasks": ["12.2", "13.1", "14.1", "14.2"] },
    { "id": 7, "tasks": ["13.2", "15.1"] },
    { "id": 8, "tasks": ["17.1", "17.2"] }
  ]
}
```
