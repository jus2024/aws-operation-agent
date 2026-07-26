# Implementation Plan: Memory ベースのチャット履歴

## Overview

本実装計画は、チャットの会話内容（発言本文）の正のデータソースを DynamoDB の `ChatMessage` から AgentCore Memory に一本化し、セッション切り替え時の会話履歴の復元を Memory からの読み出しに変更するためのコーディングタスクである。

design.md の Components and Interfaces（1. Memory 読み出し経路、2. `memoryRestore.ts`、3. フロントエンド側の変更、4. 削除対象ファイルの整理、5. 長期記憶・保持期間変更）を反映している。

進め方: IAM 権限追加（`memoryRestore.ts` の前提） → `memoryRestore.ts` の実装（純粋関数・ユニットテスト・PBT） → `handler.ts` のルーティング分岐追加 → sandbox 環境での疎通確認 → フロントエンド側の新規フック作成 → `page.tsx` の変更 → 既存の重複対策コード削除 → ブラウザでの結合確認 → 長期記憶戦略の有効化（要ユーザー承認） → 短期記憶保持期間の365日化（要ユーザー承認） → ChatMessage モデル削除判断 → README 更新、の順に進める。各タスク完了後は最も狭い範囲の検証（lint/型チェック/スモークテスト）を実施する（`testing` 方針）。フロントエンド変更は lint と型チェックを優先し、Amplify 変更はデプロイと設定への影響を必ず記載する。

### 高感度タスク（PR レビュー必須・`security` / `repo-workflow` ルール）

- **1.1** `copilotkitStreamingRelay` の実行ロールへの新規 IAM 権限（`bedrock-agentcore:ListEvents`）付与。既存の `InvokeAgentRuntime` に加えて Memory への読み取り権限を追加する変更
- **3.2** actor_id 不一致時に `ListEvents` 呼び出し自体をブロックする認可ロジックの実装。認証・認可境界そのものの変更であり、実装ミスが他ユーザーの会話内容の漏洩につながる
- **7.1 / 7.2** 既存の重複対策コード（`useChatSessionPersistence.ts` の `onNewMessage` 購読部分、`chatMessagePersistence.ts` の `buildChatMessageCreateInput`）の削除。本番で現在使われているメッセージ永続化ロジックそのものを削除する破壊的変更（Requirement 4）
- **9.1** 長期記憶戦略（`strategies`）の有効化。`AWS_MCP_Agent` と `AWS_MCP_Agent_Prod` の両 Runtime が共有する本番稼働中の Memory リソース（`agents_AWS_MCP_AgentMemory-XXXXXXXXXX`）に対する更新であり、**実行前に変更内容（設定する戦略の種類）をユーザーに提示し、明示的な承認を得てから実際の更新 API 呼び出しを行う**
- **10.1** 短期記憶の保持期間（`eventExpiryDuration`）の 365 日への変更。同じ本番共有 Memory リソースに対する更新であり、**実行前に変更内容（変更後の `eventExpiryDuration` 値）をユーザーに提示し、明示的な承認を得てから実際の更新 API 呼び出しを行う**

---

## Tasks

- [x] 1. IAM 権限追加: `bedrock-agentcore:ListEvents`（高感度）
  - [x] 1.1 `amplify/functions/copilotkitStreamingRelay/resource.ts` に Memory 読み取り権限を追加する
    - 既存の `bedrock-agentcore:InvokeAgentRuntime` の絞り込みパターン（Runtime ARN を synth 時に一度だけ読み、`[arn, `${arn}/*`]` を Resource に指定）と同様に、`bedrock-agentcore:ListEvents` を許可するポリシーを追加する
    - Memory の ARN/ID は Runtime ARN とは別の環境変数（例: `AGENTCORE_MEMORY_ID`）として管理する
    - 環境変数が未設定の場合はポリシー自体を付与しない（既存の `InvokeAgentRuntime` と同じフェイルセーフ方針を踏襲する）
    - _Requirements: 1.1, 2.1, 5.1_
    - **高感度（IAM）**: 新規に付与する権限が `bedrock-agentcore:ListEvents` のみに限定され、他のアクション（`GetEvent`・`PutEvent` 等の書き込み系）を含まないことを PR で確認する
    - 検証: `npx tsc --noEmit`（Amplify バックエンドの型チェック）。`npx ampx sandbox` で synth が成功し、新規ポリシーが正しく反映されることを確認する

- [x] 2. `memoryRestore.ts`（新規モジュール）の実装
  - [x] 2.1 型定義と `filterConversationalEvents` を実装する
    - `amplify/functions/copilotkitStreamingRelay/memoryRestore.ts` を新規作成し、`MemoryEvent` 型と `filterConversationalEvents` を実装する（`payload[0].conversational` を持つイベントのみを抽出し、`payload[0].blob` を持つ AGENT/SESSION 状態イベントを除外、相対順序は保持）
    - Property 1（conversational イベントのみが残る）を検証する PBT（`fast-check`、`numRuns: 100`）を `memoryRestore.filterConversationalEvents.pbt.test.ts` に実装する
    - _Requirements: 2.2, 5.1_
    - 検証: ユニットテスト・PBT の実行（`npm test` または対象ファイル指定）。ローカル実行のみで完結することを確認する（実際の AgentCore Runtime デプロイ不要、Requirement 5.1）

  - [x] 2.2 `parseConversationalEventPayload` を実装する
    - `payload[0].conversational.content.text` の JSON 文字列をパースし `{role, content}` に変換する。パース失敗時・`message.role`/`message.content` が期待形式でない場合は例外を投げず `null` を返す
    - Property 2（不正なペイロードは常に安全にフォールバックする）を検証する PBT を `memoryRestore.parseConversationalEventPayload.pbt.test.ts` に実装する（有効な JSON と無効な文字列の両方を生成する fast-check ジェネレーターを使う）
    - _Requirements: 2.7_
    - 検証: ユニットテスト・PBT の実行

  - [x] 2.3 `convertMemoryEventsToAGUIMessages` を実装する
    - パース済みイベント列を AG-UI Message 形式（text / toolCall / toolResult）に変換する。assistant の `toolUse` ブロックからツールカード相当のメッセージ構造を構築し、後続 user イベントの `toolResult` を同じ `toolUseId` で紐付ける。イベントの並び順（`eventTimestamp` 昇順）を保持し、パース失敗イベントは省略する
    - Property 3（toolUse と toolResult は toolUseId によって一意に紐付く）を検証する PBT を `memoryRestore.toolUseToolResultPairing.pbt.test.ts` に実装する
    - Property 4（変換後のメッセージ列は時系列順序を保存する）を検証する PBT を `memoryRestore.chronologicalOrder.pbt.test.ts` に実装する
    - _Requirements: 2.2, 2.6_
    - 検証: ユニットテスト・PBT の実行。実際に `list-events` で確認したペイロード構造（`toolUse` を含むイベント、`toolResult` を含むイベント、通常発言のイベント）を模したフィクスチャで検証する

  - [x] 2.4 変換パイプラインの冪等性を検証するテストを追加する
    - `filterConversationalEvents` → `parseConversationalEventPayload` → `convertMemoryEventsToAGUIMessages` を同一入力で複数回実行し、常に同一の `AGUIMessage` リストを返すことを検証する Property 6 の PBT を `memoryRestoreIdempotency.pbt.test.ts` に実装する
    - _Requirements: 2.3_
    - 検証: PBT の実行

- [x] 3. `handler.ts` へのルーティング分岐追加
  - [x] 3.1 Memory 読み出しエンドポイントのルーティング分岐を実装する
    - `handler.ts` の先頭で HTTP メソッド（`GET`）または専用パス（`/memory/events`）により、既存の `copilotRuntimeNodeHttpEndpoint` への委譲より前に新しいハンドラー分岐（`handleMemoryRestoreRequest` 相当）へルーティングする（`event.rawPath` を自前で判定する。Lambda 関数 URL はパスベースのルーティング機能を持たないため）
    - この分岐は既存の認証ゲート（Bearer トークンなし/無効 → 401）を再利用し、クエリパラメータ `sessionId`（および `nextToken`）を読み取って `bedrock-agentcore:ListEvents` を呼び出し、`memoryRestore.ts` の変換パイプラインを通した結果を `{ messages, nextToken }` の JSON レスポンス（`writeJsonResponse` 相当）として1回で返す
    - Memory の呼び出しが失敗した場合は `{ error: string }` を返す
    - _Requirements: 1.1, 2.1, 2.4, 2.5_
    - 検証: 既存の AG-UI ストリーミング経路（`POST`）に影響がないことをユニットテスト（`handler.test.ts` への追加）で確認する

  - [x] 3.2 actor_id 不一致時の認可ブロックを実装する（高感度: 認証経路）
    - 選択された `sessionId` に対応する actor_id と、Bearer トークンから抽出した認証済みユーザーの actor_id を比較し、一致しない場合は `ListEvents` 呼び出し自体を発行せずに処理を拒否する（403 相当のエラーレスポンス）。データを取得した後に結果を拒棄する実装は行わない
    - Property 5（actor_id が一致しない場合、Memory 取得呼び出し自体が発生しない）を検証する PBT を `memoryRestoreAuthorization.pbt.test.ts` に実装する（`ListEvents` 相当の呼び出しをモックし、呼び出し回数が0であることを検証する）
    - _Requirements: 3.1, 3.2_
    - **高感度（認証経路）**: 呼び出し前検証であること（fetch-then-reject ではないこと）を PR で明示し、実装がガード条件をすり抜けて `ListEvents` を発行する経路が存在しないことを確認する
    - 検証: PBT の実行。ユニットテストで actor_id 不一致時に呼び出しモックが一度も呼ばれないことを確認する

- [x] 4. sandbox 環境での Memory 読み出しエンドポイントの疎通確認
  - [x] 4.1 `npx ampx sandbox` でデプロイし、実データでの疎通確認を行う
    - タスク 1 の IAM 権限がデプロイされた状態で、`GET {functionUrl}/memory/events?sessionId=...` に対する実際のリクエストを送信し、`actor_id`/`session_id` で正しくスコープされた `ListEvents` レスポンスが返ることを1〜2件の代表データで確認する
    - _Requirements: 2.1, 5.2_
    - 検証: 実機確認結果（レスポンスの内容、エラー時の挙動）を記録する。Amplify Hosting 本番環境と挙動が一致することを確認する観点を記載する

- [x] 5. フロントエンド: `useSessionMemoryRestore.ts` 新規作成
  - [x] 5.1 `src/lib/agent/useSessionMemoryRestore.ts` を新規作成する
    - `activeSessionId` が変わるたびに Memory 読み出しエンドポイント（`GET {functionUrl}/memory/events?sessionId=...`）を呼び出し、レスポンスの `messages` を `agent.setMessages()` に渡す
    - Memory 側の状態を変更しない読み取り専用操作のため、`useChatSessionPersistence.ts` の `persistedContentKeysRef` のような重複ガードは実装しない
    - 取得失敗時（Requirement 2.5）はエラー状態を呼び出し元（`page.tsx`）に伝え、再試行できるようにする
    - `sessionId` に対応する Memory_Event が0件の場合は空の会話として扱う（Requirement 2.4）
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
    - 検証: ユニットテストで、Memory 読み出し API のモックに対して `activeSessionId` 変更時に1回だけ呼び出されることを確認する。型チェック・lint

- [x] 6. フロントエンド: `page.tsx` の変更とセッション名自動生成ロジックの分離
  - [x] 6.1 `page.tsx` の `SessionChatWithPersistence` を Memory 読み出し API 呼び出しに切り替える
    - `client.models.ChatMessage.listChatMessageBySessionCreatedAt` を呼ぶ現行の `useEffect` を、タスク 5 の `useSessionMemoryRestore` フックの呼び出しに置き換える
    - `sortMessagesByCreatedAt` は Memory 側が既に時系列順で返すため不要になるが、防御的に順序を保証する目的で流用してもよい
    - `ChatSession.ownerUserId` による認可拒否挙動（Requirement 3.3）は変更しない
    - _Requirements: 1.4, 2.2, 3.3_
    - 検証: 型チェック・lint。sandbox 環境（フロントエンド + Memory 読み出しエンドポイント）でブラウザから実際にセッションを切り替え、会話履歴が復元されることを目視確認する

  - [x] 6.2 セッション名自動生成ロジックの新しい検知方式を確定・実装する
    - 現行の `renameSession` 呼び出しは `onNewMessage` の中で「最初のユーザーメッセージ送信時」を検知していたが、この購読自体が削除される（タスク 7）ため、別の検知手段（CopilotKit v2 の AG-UI イベント購読、または `SessionChatWithPersistence` 側の送信ハンドラーへの直接フック）を1つ選定して実装する
    - DynamoDB（`ChatSession.sessionName`）への書き込みであり、Memory への書き込みではないことを明確に分離したまま実装する
    - _Requirements: 1.2, 1.3_
    - 検証: 型チェック・lint。sandbox 環境で新規チャット開始後、最初のメッセージ送信時にセッション名が自動生成されることを目視確認する

- [x] 7. 既存の重複対策コード削除（高感度: 破壊的変更）
  - [x] 7.1 `src/lib/agent/useChatSessionPersistence.ts` の `onNewMessage` 購読部分を削除する
    - `onNewMessage` 購読・`persistedContentKeysRef` による重複ガード・`extractTextContent`・`ChatMessage.create()` への書き込みロジックを全て削除する。`loadMessagesIntoAgent` 相当の機能はタスク 5 の `useSessionMemoryRestore.ts` に既に引き継がれているため、本タスクでは重複コードとして完全に削除する（実装に迷いがある場合でも、Requirement 1/2 への影響の不確実性を理由に残さない）
    - _Requirements: 1.2, 4.1_
    - **高感度（破壊的変更）**: 本番で現在使われているメッセージ永続化ロジックの削除。タスク 5・6 のフロントエンド変更が先にデプロイ・確認済みであることを PR で確認する
    - 検証: 型チェック・lint。削除後にビルド（`npm run build`）が成功することを確認する

  - [x] 7.2 `src/lib/agent/chatMessagePersistence.ts` の `buildChatMessageCreateInput` を削除する
    - `buildChatMessageCreateInput` とその呼び出し元を削除する。`buildChatSessionCreateInput` は変更せず継続使用する（Requirement 1.3 — `ChatSession` メタデータ永続化ロジックとの非依存性を維持する）
    - 既存のユニットテスト（`buildChatMessageCreateInput` を対象とするテストがある場合）も削除する
    - _Requirements: 1.3, 4.1, 4.2_
    - **高感度（破壊的変更）**: `buildChatSessionCreateInput` を誤って一緒に削除・変更しないこと（メタデータ永続化への影響がないこと）を PR で確認する
    - 検証: 型チェック・lint。削除後にビルドが成功することを確認する

- [x] 8. 結合確認（sandbox 環境でブラウザから実際に確認）
  - [x] 8.1 実ブラウザでのセッション復元・ツールカード再現を確認する
    - sandbox 環境（フロントエンド + `copilotkitStreamingRelay`）に対し、ツール呼び出しを含む会話を行った後、別セッションに切り替えてから元のセッションに戻り、会話内容とツールカードが重複・欠落なく再現されることを目視確認する
    - セッションを複数回切り替えても表示内容が累積・重複しないこと（Requirement 2.3）を確認する
    - Memory_Event が0件のセッション（新規作成直後）で空の会話area が表示されることを確認する（Requirement 2.4）
    - _Requirements: 1.4, 2.2, 2.3, 2.4, 2.6_
    - 検証: 実機確認結果（スクリーンショットまたは確認手順のログ）を記録する

- [x] 9. 長期記憶戦略の有効化（高感度、実行前にユーザー確認必須）
  - [x] 9.1 `agents_AWS_MCP_AgentMemory-XXXXXXXXXX` に Long_Term_Memory_Strategy を設定する
    - 設定する戦略の種類（`SemanticMemoryStrategy` または `SummaryMemoryStrategy` 等、actor_id 単位でスコープされる戦略）を決定し、変更内容を事前にユーザーへ提示する
    - **実行前にユーザーに変更内容を提示し、明示的な承認を得てから実際の更新 API 呼び出しを行う**（AgentCore CLI または AWS CLI の Memory 更新系 API を使用）
    - 承認後、実際の更新操作を実行し、`strategies` が空でなくなったこと、長期記憶抽出が actor_id 単位でスコープされることを確認する
    - _Requirements: 6.1, 6.2, 6.3_
    - **高感度（本番共有リソース変更）**: `AWS_MCP_Agent` と `AWS_MCP_Agent_Prod` の両 Runtime が共有するリソースへの変更であり、ユーザー承認前に実際の更新 API 呼び出しを行わないこと
    - 検証: 更新後、Memory リソースの `strategies` フィールドを取得し、設定した戦略が反映されていることを確認する

- [x] 10. 短期記憶保持期間の365日化（高感度、実行前にユーザー確認必須）
  - [x] 10.1 `agents_AWS_MCP_AgentMemory-XXXXXXXXXX` の `eventExpiryDuration` を365日に変更する
    - 変更後の値（365日）を事前にユーザーへ提示する
    - **実行前にユーザーに変更内容を提示し、明示的な承認を得てから実際の更新 API 呼び出しを行う**
    - 承認後、実際の更新操作を実行する
    - _Requirements: 7.1, 7.2_
    - **高感度（本番共有リソース変更）**: タスク 9 と同一の本番共有リソースへの変更であり、ユーザー承認前に実際の更新 API 呼び出しを行わないこと
    - 検証: 更新後、Memory リソースの `eventExpiryDuration` を取得し、365日に変更されていることを確認する

- [x] 11. `ChatMessage` モデル・GSI の削除判断
  - [x] 11.1 `amplify/data/resource.ts` の `ChatMessage` モデル定義・DynamoDB テーブルの削除タイミングを判断する
    - タスク 7 完了時点で `ChatMessage` への読み書きコードパスは全て削除されているため、モデル定義自体（および対応する DynamoDB テーブル）を即座に削除するか、既存データの扱い（移行しない、Requirement の対象範囲外）を踏まえて別タスクとして先送りするかを判断する
    - 本タスクではスキーマの削除は実施しない（破壊的変更・DynamoDB テーブル削除を伴うため、実施の判断自体を目的とする）
    - _Requirements: 4.2_
    - 検証: 判断結果（削除する/先送りする、先送りする場合の理由）を PR またはドキュメントに記録する

- [x]* 12. README・ドキュメント更新
  - [x] 12.1 README に AgentCore Memory ベースの会話履歴復元への変更点を追記する
    - `ChatMessage` への読み書きが廃止されたこと、`bedrock-agentcore:ListEvents` 権限が新規に必要になったこと、Memory 読み出しエンドポイント（`GET {functionUrl}/memory/events`）の存在を記載する
    - 長期記憶戦略・保持期間365日への変更（タスク 9・10 の結果）を記載する
    - _Requirements: 4.2, 5.1, 5.2_

## 運用者タスク（Kiro からは実行不可、手動対応が必要）

- **O1**: タスク 9（長期記憶戦略の有効化）・タスク 10（保持期間365日化）で Kiro が提示する変更内容を確認し、実際の AWS API 呼び出しを実行してよいと明示的に承認する
- **O2**: 本番 Amplify Hosting（`main` ブランチ）へのデプロイ前に、タスク 4（sandbox 疎通確認）・タスク 8（結合確認）の結果と、タスク 7（既存重複対策コード削除）が同一コミットに含まれていることを確認し、本番デプロイを承認する
- **O3**: 本番デプロイ後、実際のブラウザ操作でセッション復元・ツールカード再現を目視確認する
- **O4**: タスク 11 で判断された `ChatMessage` モデル・DynamoDB テーブルの削除を実施するかどうか、実施する場合はそのタイミングを決定する
