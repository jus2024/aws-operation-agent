# Implementation Plan: チャットセッション履歴管理

## Overview

チャットセッションとメッセージを Amplify Data（DynamoDB）に永続化し、画面左側にセッション履歴サイドバーを追加する。実装は「データモデル → 純粋関数 + PBT → フック → UI → 統合」の順で進める。

## Tasks

- [x] 1. データモデル拡張
  - [x] 1.1 `amplify/data/resource.ts` に ChatSession フィールド追加と ChatMessage モデルを新設する
    - `ChatSession` に `sessionName: a.string().required()` と `updatedAt: a.datetime().required()` を追加
    - `ChatSession` に `secondaryIndexes` で `ownerUserId` + `updatedAt` の GSI を追加（`listChatSessionByOwnerUpdatedAt`）
    - `ChatMessage` モデルを新規追加（`sessionId`, `ownerUserId`, `role`, `content`, `createdAt`）
    - `ChatMessage` に `secondaryIndexes` で `sessionId` + `createdAt` の GSI を追加（`listChatMessageBySessionCreatedAt`）
    - `ChatMessage` に `allow.owner()` 認可を設定
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4_

- [x] 2. 純粋関数モジュール実装
  - [x] 2.1 `src/lib/agent/sessionNameResolver.ts` を新規作成する
    - `DEFAULT_SESSION_NAME`, `MAX_SESSION_NAME_LENGTH`, `MAX_GENERATED_NAME_LENGTH` 定数をエクスポート
    - `defaultSessionName()`: "新しいチャット" を返す
    - `generateSessionName(messageText)`: 先頭30文字以内でセッション名を生成、空入力時はデフォルト名を返す
    - `resolveSessionName(candidate, previous)`: 空値フォールバック・100文字切り詰めロジック
    - _Requirements: 1.3, 4.1, 4.3, 4.4, 5.3, 5.4_

  - [ ]* 2.2 `src/lib/agent/__tests__/sessionNameResolver.pbt.test.ts` を新規作成する
    - **Property 3: セッション名解決の境界と空値フォールバック**
    - **Property 8: 生成セッション名の長さ制約**
    - **Validates: Requirements 1.3, 4.1, 4.4, 5.3, 5.4**

  - [x] 2.3 `src/lib/agent/sessionSort.ts` を新規作成する
    - `sortSessionsByUpdatedAtDesc`: updatedAt 降順ソート
    - `sortMessagesByCreatedAt`: createdAt 昇順ソート
    - `selectNextActiveSession`: 残存セッションから updatedAt 最大を選択、空なら null
    - `selectMessageIdsForSessionDeletion`: 対象セッションのメッセージ ID を抽出
    - _Requirements: 2.4, 3.3, 7.2, 7.3, 7.4_

  - [ ]* 2.4 `src/lib/agent/__tests__/sessionSort.pbt.test.ts` を新規作成する
    - **Property 5: メッセージの作成日時順序保存**
    - **Property 7: セッション一覧の更新日時降順ソート保存**
    - **Property 11: 削除後のアクティブセッション選択**
    - **Validates: Requirements 2.4, 3.3, 7.3, 7.4**

  - [x] 2.5 `src/lib/agent/relativeTime.ts` を新規作成する
    - `formatRelativeTime(timestamp, now?)`: 「今」「N分前」「N時間前」「昨日」「N日前」「日付文字列」のバケットに分類
    - _Requirements: 3.2_

  - [ ]* 2.6 `src/lib/agent/__tests__/relativeTime.pbt.test.ts` を新規作成する
    - **Property 6: 相対時刻フォーマットのバケット網羅性**
    - **Validates: Requirements 3.2**

  - [x] 2.7 `src/lib/agent/chatMessagePersistence.ts` を新規作成する
    - `buildChatMessageCreateInput`: sessionId, role, content から createdAt 付きペイロードを構築
    - `buildChatSessionCreateInput`: ownerUserId, connectionId, operationScope から sessionName・startedAt・updatedAt 付きペイロードを構築
    - _Requirements: 1.1, 2.1, 2.2, 4.3_

  - [ ]* 2.8 `src/lib/agent/__tests__/chatMessagePersistence.pbt.test.ts` を新規作成する
    - **Property 1: セッション作成ペイロードの完全性**
    - **Property 4: メッセージ作成ペイロードの完全性**
    - **Validates: Requirements 1.1, 2.1, 2.2, 4.3**

  - [ ]* 2.9 `src/lib/agent/__tests__/sessionDeletionCascade.pbt.test.ts` を新規作成する
    - **Property 10: カスケード削除は対象セッションのメッセージのみを選択する**
    - **Validates: Requirements 7.2**

  - [ ]* 2.10 `src/lib/agent/__tests__/newSessionContext.pbt.test.ts` を新規作成する
    - **Property 9: 新規セッションは接続コンテキストを継承する**
    - **Validates: Requirements 6.3**

- [x] 3. Checkpoint - 純粋関数とPBTの検証
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. フック実装
  - [x] 4.1 `src/lib/agent/useChatSessions.ts` を新規作成する
    - `generateClient<Schema>()` を使用し既存パターン（`useConnectionCatalog`）に従う
    - `sessions`, `isLoading`, `error`, `refresh` の状態管理
    - `createSession`: `buildChatSessionCreateInput` + `client.models.ChatSession.create`
    - `renameSession`: `resolveSessionName` を適用して `client.models.ChatSession.update`
    - `deleteSession`: `selectMessageIdsForSessionDeletion` で対象メッセージ取得 → 並行削除 → セッション削除
    - `touchSession`: 空更新で `updatedAt` を進める
    - GSI `listChatSessionByOwnerUpdatedAt` で所有者のセッション一覧を取得
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 5.2, 5.3, 5.4, 6.3, 7.2_

  - [x] 4.2 `src/lib/agent/useChatSessionPersistence.ts` を新規作成する
    - `useAgent()` の `AgentSubscriber.onNewMessage` を購読してメッセージ永続化
    - `user` / `assistant` ロールのテキストメッセージのみ永続化（ツールコールは対象外）
    - 最初のユーザーメッセージ送信時に `generateSessionName` でセッション名を自動生成
    - セッション切替時に `agent.setMessages()` で履歴を注入
    - `buildChatMessageCreateInput` を使用してペイロード構築
    - メッセージ永続化後に `touchSession` を呼び出す
    - エラー発生時はチャット UI を継続動作させる（ベストエフォート永続化）
    - _Requirements: 1.2, 2.1, 2.2, 4.1, 4.2, 6.1, 6.2, 6.4_

- [x] 5. Checkpoint - フック実装の検証
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. UI コンポーネント実装
  - [x] 6.1 `src/components/agent/SessionHistorySidebar.tsx` を新規作成する
    - `SessionHistorySidebarProps` インターフェースに基づくコンポーネント
    - セッション一覧表示（`sessionName` + `formatRelativeTime(updatedAt)`）
    - アクティブセッションのハイライト表示
    - 新規セッション作成ボタン
    - ダブルクリックでインライン編集（Enter/blur で確定）
    - 削除アイコン + `window.confirm` 相当の確認 UI
    - `collapsed` 状態でのトグル表示（レスポンシブ対応）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 7.1_

- [x] 7. ページ統合
  - [x] 7.1 `src/app/page.tsx` を拡張してサイドバー + チャットの左右分割レイアウトにする
    - `session_active` 状態で `SessionHistorySidebar` + `CopilotProvider > SessionChat` のレイアウトに変更
    - アクティブセッション ID を `page.tsx` の state で管理
    - `useChatSessions` フックを組み込みセッション CRUD を接続
    - `useChatSessionPersistence` フックを `CopilotProvider` 内部で使用
    - セッション選択時に `ChatMessage.list` → `sortMessagesByCreatedAt` → `agent.setMessages()` のフロー実装
    - `CopilotKit` コンポーネントの `threadId` prop にセッション ID を渡す
    - 削除後の `selectNextActiveSession` による自動セッション切替
    - セッション0件時の空状態（新規チャット開始案内）表示
    - _Requirements: 3.1, 3.4, 6.1, 6.2, 6.3, 6.4, 7.3, 7.4_

- [x] 8. Final checkpoint - 全体統合の検証
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (11 properties)
- Unit tests validate specific examples and edge cases
- `amplify/data/resource.ts` の変更後は `npx ampx sandbox` でスキーマデプロイを確認すること
- CopilotKit v2 の `useAgent` / `AgentSubscriber` API は `@copilotkit/react-core/v2` から import する
- 既存パターン（`useConnectionCatalog` / `useConnectionAdmin`）の構造規約に従うこと

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.5", "2.7"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.6", "2.8", "2.9", "2.10"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["7.1"] }
  ]
}
```
