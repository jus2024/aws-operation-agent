# Requirements Document

## Introduction

現在、チャットの会話内容（`Chat_Message`：発言者・本文・作成時刻）は `chat-session-history` 仕様に基づき DynamoDB の `ChatMessage` モデルに永続化されている。この永続化は CopilotKit フロントエンドの `onNewMessage` 購読による事後書き込みで実現されているが、この方式には以下の既知の問題がある。

- CopilotKit v2 は単一の共有エージェントインスタンス（`agent.setMessages()` による事後呼び出し方式）で動作するため、`onNewMessage` が同一メッセージに対して複数回発火し、DynamoDB に同一内容が重複して書き込まれる現象が複数回確認されている（`emit_messages_snapshot` の設定変更や `message.id` ベースのガード、`role + 本文` ベースのガードなど複数の対策を試みたが解消せず、調査は一旦中断している）。
- AgentCore Runtime には既に AgentCore Memory（短期記憶）が組み込まれており、`actor_id`（Cognito の `sub`）と `session_id` でスコープされた会話履歴を保持している。AG-UI プロトコルが一度のリクエストで受け取る会話内容は Memory 上の内容と実質的に同一であり、DynamoDB への重複した会話内容の永続化は、Memory という単一の正とすべきソースを持ちながら、もぐらたたき的な重複対策を UI 層に積み重ねる形になっている。

本仕様は、チャットの会話内容（発言本文）の正のデータソースを DynamoDB の `ChatMessage` から AgentCore Memory に一本化し、セッション切り替え時の会話履歴の復元を Memory からの読み出しに変更することで、この重複問題を構造的に解消することを目的とする。

### 方針（ユーザーとの合意事項）

- **セッションのメタデータ（`ChatSession`：`sessionName`・`updatedAt`・`roleNames`・`ownerUserId` 等）は DynamoDB に保持し続ける。** Memory は会話の発言内容の短期記憶であり、セッション名や更新日時のようなメタデータを保持する仕組みではないため、この点をユーザーは明確に認識しており、DynamoDB でのメタデータ管理自体は否定していない。
- **DynamoDB の `ChatMessage` モデル（発言内容そのものの永続化）は本仕様の実装後、書き込み・読み出しの両方で使用を終了する。** 既存の重複書き込みの温床となっている `onNewMessage` 購読による事後書き込みロジックを撤廃する。
- Session_History_Sidebar でセッションを切り替えた際の会話履歴の復元は、AgentCore Memory から会話内容を取得する方式に変更する。
- ツールカード（ツール呼び出しの可視化 UI）については、DynamoDB から復元した会話履歴では元々表示されなかった（現行の DynamoDB ベースの実装の制約）。しかし AgentCore_Memory の Memory_Event には Bedrock Converse API 形式でツール呼び出し（`toolUse`）・ツール実行結果（`toolResult`）の詳細がそのまま記録されているため、Memory ベースの復元ではこの制約を解消し、当時の会話をできるだけそのまま再現する形でツールカードも再構築して表示する（Requirement 2 参照）。
- AgentCore Memory の長期記憶（`strategies`）を有効化し、`actor_id` 単位でセッションをまたいだ記憶抽出を可能にする（Requirement 6 参照）。この変更は `AWS_MCP_Agent` と `AWS_MCP_Agent_Prod` の両 Runtime が共有する本番稼働中の Memory リソースに対する変更であり、高感度変更として扱う。
- AgentCore Memory の短期記憶（イベント）の保持期間（`eventExpiryDuration`）を、現行の 30 日から 365 日に変更する（Requirement 7 参照）。

### 既存仕様との関係

- **`chat-session-history`（メタデータ管理は維持、発言内容の永続化方式は本仕様で置き換え）**: `ChatSession` モデル（メタデータ）はそのまま利用する。`ChatMessage` モデル（発言内容）への書き込み・読み出しは本仕様で終了し、発言内容の唯一の正のデータソースを AgentCore Memory に一本化する。
- **`role-set-switching`（影響なし、前提として利用）**: `actor_id` を Cognito の `sub` に正しく紐付ける実装（`extractCognitoSub()`、`X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId` ヘッダー）は既に完了・デプロイ・検証済みであり、本仕様はこの実装を前提とする（Memory のスコープが `actor_id` + `session_id` で正しく分離されていることが本仕様の実現可能性の前提条件）。

## 対象範囲外（スコープ外）

- `ChatSession` モデル（セッション名・更新日時・Role_Set 等のメタデータ）の DynamoDB での管理方式の変更。これは維持する。
- Amplify Hosting でのストリーミング配信の実現（別仕様 `amplify-streaming-response` で対応する）。
- 既存の `ChatMessage` DynamoDB テーブルに蓄積された過去データの移行。本仕様の実装後、新規に開始されるセッションの会話内容は Memory にのみ保存され、過去に `ChatMessage` に書き込まれたデータの移行・削除は本仕様の対象外とする（別途運用判断とする）。

## Glossary

- **AgentCore_Memory**: Amazon Bedrock AgentCore が提供する Memory リソース。`actor_id` と `session_id` でスコープされた短期記憶（イベント）を保持し、`ListEvents`/`GetEvent` 等の API で取得できる
- **actor_id**: AgentCore Memory 上で会話の主体を識別するキー。本プロジェクトでは Cognito の `sub` クレームを使用する（role-set-switching 仕様で対応済み）
- **session_id**: AgentCore Memory 上で会話セッションを識別するキー。本プロジェクトの `Chat_Session` の ID と対応させる
- **Chat_Session**: DynamoDB の `ChatSession` モデルに永続化される、チャットセッションのメタデータレコード（`sessionName`・`updatedAt`・`roleNames`・`ownerUserId` 等）。本仕様では変更しない
- **Chat_Message**: 個々の発言（ユーザー発言・アシスタント応答）。現行は DynamoDB の `ChatMessage` モデルに永続化されているが、本仕様の実装後は AgentCore_Memory から取得する
- **Session_History_Sidebar**: 過去の Chat_Session 一覧を表示するサイドバー UI コンポーネント
- **Session_Restore**: ユーザーが Session_History_Sidebar から過去の Chat_Session を選択した際に、その会話内容を画面に復元する処理
- **Memory_Event**: AgentCore Memory 上に記録される、1回のやり取り（ユーザー発言・アシスタント応答等）を表す単位。Bedrock Converse API 形式で記録され、ASSISTANT ロールの `content` 配列にはツール呼び出し（`toolUse`：ツール名・引数を含む）が、USER ロールの `content` 配列にはツール実行結果（`toolResult`）が含まれ得る
- **Long_Term_Memory_Strategy**: AgentCore_Memory に設定される長期記憶の抽出戦略（例: `SemanticMemoryStrategy`、`SummaryMemoryStrategy` 等、AgentCore Memory がサポートする戦略）。`actor_id` 単位でセッションをまたいだ記憶抽出を行う
- **Frontend**: Next.js フロントエンドアプリケーション
- **API_Route**: `src/app/api/copilotkit/route.ts` に配置される Next.js Route Handler
- **Agent**: AgentCore Runtime 上で動作する Strands エージェント

## Requirements

### Requirement 1: 発言内容の永続化先を AgentCore Memory に一本化

**User Story:** As a developer, I want the content of each chat message to be persisted exclusively in AgentCore Memory rather than duplicated into DynamoDB, so that the known message-duplication bug rooted in the DynamoDB write path is eliminated at its source rather than patched with additional UI-layer workarounds.

#### Acceptance Criteria

1. WHEN a user sends a message or the Agent responds within a Chat_Session, THE System SHALL rely on AgentCore Runtime's existing built-in mechanism for recording that exchange into AgentCore_Memory, scoped by the request's actor_id and session_id.
2. THE Frontend SHALL NOT write Chat_Message content (user or assistant message text) to DynamoDB via any subscription-based mechanism (e.g., an `onNewMessage`-style callback) after this feature is implemented.
3. THE System SHALL persist Chat_Session metadata (sessionName, updatedAt, roleNames, ownerUserId) to DynamoDB using a persistence mechanism that shares no code path with, and does not depend on, the mechanism used to write Chat_Message content, such that removing the Chat_Message content write path SHALL require no change to the Chat_Session metadata persistence logic.
4. THE removal of the DynamoDB Chat_Message write path SHALL NOT alter how a Chat_Session's live conversation is displayed to the user while that session is actively open (i.e., while messages are streaming in via AG-UI events during the current browser tab session).

### Requirement 2: AgentCore Memory からの過去セッション会話履歴の復元

**User Story:** As a user, I want to see my past conversation reappear as close as possible to how it originally looked when I switch back to a previous chat session, including any tool calls that were made, so that I can continue where I left off without losing context.

#### Acceptance Criteria

1. WHEN a user selects a past Chat_Session from the Session_History_Sidebar, THE Session_Restore process SHALL retrieve that session's Memory_Event history from AgentCore_Memory, scoped by the actor_id of the currently authenticated user and the session_id corresponding to the selected Chat_Session.
2. WHEN Memory_Event history is retrieved for a selected Chat_Session, THE Frontend SHALL render each user message and each assistant message from that history in the Chat_UI in chronological order, without duplicating any message.
3. WHEN a user switches from one past Chat_Session to another and then back to the first, THE Frontend SHALL display the same set of messages each time, without messages accumulating or repeating across switches (this directly addresses the previously observed bug where reopening a session caused prior messages to reappear duplicated).
4. IF AgentCore_Memory contains zero Memory_Event records for a selected Chat_Session's session_id (e.g., a session that was created but no message was ever sent), THEN THE Frontend SHALL display that Chat_Session with an empty conversation area, consistent with the current behavior for a newly created, empty session.
5. IF the retrieval of Memory_Event history from AgentCore_Memory fails (e.g., a transient AWS error), THEN THE Frontend SHALL display an error indication to the user rather than silently showing an empty or partial conversation, and SHALL allow the user to retry the retrieval.
6. WHEN a Memory_Event's payload contains a `toolUse` content block (a tool invocation, including the tool name and input) or a `toolResult` content block (the corresponding tool execution result), THE Session_Restore process SHALL reconstruct and display the corresponding tool-call visualization (tool card) in the Chat_UI, using the tool name, input, and result recorded in that event's payload, so that restored historical messages reproduce the original conversation as closely as reasonably possible, including tool calls.
7. IF a Memory_Event's payload does not contain sufficient information to reconstruct a tool card (e.g., a malformed or unexpected payload structure), THEN THE Session_Restore process SHALL fall back to displaying that event as plain text, or omitting it, rather than failing the entire Session_Restore process.

### Requirement 3: 認可境界の維持（他ユーザーの会話への非アクセス）

**User Story:** As a user, I want my past conversations to remain visible only to me, so that switching the underlying storage mechanism does not introduce a privacy or authorization regression.

#### Acceptance Criteria

1. WHEN the Session_Restore process retrieves Memory_Event history for a selected Chat_Session, THE System SHALL scope that retrieval to the actor_id of the currently authenticated user, derived the same way actor_id is derived for live chat requests (the Cognito `sub` claim propagated via the existing header mechanism).
2. IF the session_id supplied for a Memory_Event history retrieval corresponds to a Chat_Session whose actor_id differs from that of the currently authenticated user, THEN THE System SHALL prevent the retrieval operation from being executed at all (i.e., SHALL NOT issue the underlying AgentCore_Memory retrieval call for that actor_id) and SHALL NOT display any Memory_Event data to the user, rather than issuing the retrieval and rejecting the result after the data has already been fetched.
3. IF a user attempts to select a Chat_Session whose ownerUserId (from the DynamoDB Chat_Session metadata) does not match the currently authenticated user, THEN THE Frontend SHALL apply the same authorization rejection behavior it currently applies for such a mismatch, independent of this feature's changes to message-content storage.

### Requirement 4: 既存の重複対策コードの整理

**User Story:** As a developer, I want the abandoned duplicate-message workarounds to be removed once the root cause is fixed, so that the codebase does not retain dead or confusing mitigation code alongside the real fix.

#### Acceptance Criteria

1. WHEN this feature's implementation removes the DynamoDB Chat_Message write path, THE System SHALL remove all code paths identified as existing solely to work around the message-duplication bug in that write path (e.g., message-id-based or content-based deduplication guards specific to the `onNewMessage` write flow), and SHALL NOT retain any such identified workaround code path on the basis of uncertainty about its effect on Requirement 1 or Requirement 2's behavior.
2. THE Design_Document SHALL identify each file or module removed or substantially simplified as a result of eliminating the DynamoDB Chat_Message write path, so that the scope of code removal is explicit before implementation begins.

### Requirement 5: ローカル開発・sandbox 環境での検証可能性

**User Story:** As a developer, I want to verify Memory-based history restoration locally before relying on it in the deployed environment, so that I can validate actor_id scoping and event ordering without needing a full Amplify Hosting deployment cycle.

#### Acceptance Criteria

1. THE Session_Restore process SHALL be verifiable using the local development workflow (`agentcore dev` or `uvicorn`, per this project's testing policy) by invoking the underlying Memory retrieval logic directly, without requiring a deployed AgentCore Runtime.
2. WHEN Memory-based restoration is exercised in local development or the Amplify Gen 2 sandbox environment, THE behavior observed SHALL be consistent with the behavior expected in the Amplify Hosting production environment, aside from the actor_id and session_id values themselves differing between environments.

### Requirement 6: actor_id 単位の長期記憶の有効化

**User Story:** As a developer, I want AgentCore Memory's long-term memory to be enabled and scoped per actor_id, so that the agent can retain insights about a user across multiple sessions, not just within the single session currently in view.

#### Acceptance Criteria

1. THE AgentCore_Memory resource SHALL have at least one Long_Term_Memory_Strategy configured and active (the resource currently operates with `strategies: []`, i.e., no long-term memory strategy configured).
2. Long-term memory extraction produced by the configured Long_Term_Memory_Strategy SHALL be scoped by actor_id, consistent with how short-term memory (session history) is already scoped by actor_id and session_id.
3. BECAUSE the AgentCore_Memory resource targeted by this requirement (`agents_AWS_MCP_AgentMemory-XXXXXXXXXX`) is shared by both the `AWS_MCP_Agent` and `AWS_MCP_Agent_Prod` Runtimes and is currently operating in production, THE configuration of a Long_Term_Memory_Strategy on this resource SHALL be treated as a high-sensitivity change requiring explicit confirmation before being applied, consistent with this project's security policy for IAM, deployment, and shared-resource changes.

### Requirement 7: 短期記憶の保持期間の延長

**User Story:** As a developer, I want AgentCore Memory's short-term memory event expiry duration extended from its current default, so that restored conversation history remains available for a full year rather than expiring after 30 days.

#### Acceptance Criteria

1. THE AgentCore_Memory resource's short-term memory event expiry duration (`eventExpiryDuration`) SHALL be configured to 365 days, changed from the current 30-day configuration.
2. THE change to `eventExpiryDuration` SHALL apply to the same shared AgentCore_Memory resource referenced in Requirement 6, and SHALL therefore also be treated as a high-sensitivity change requiring explicit confirmation before being applied.
