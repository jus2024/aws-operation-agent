/**
 * Memory 読み出しハンドラーの認可判定ロジック（`handler.ts` の
 * `handleMemoryRestoreRequest` に対する actor_id 不一致時のブロック処理、
 * memory-based-chat-history タスク 3.2）。
 *
 * `relay.ts` / `memoryRestore.ts` と同様に「純粋関数 + I/O ヘルパー」構成を
 * 取る。このモジュールは比較ロジックのみを持つ純粋関数を提供し、DynamoDB への
 * 実際の `GetItem` 呼び出し（I/O）は `handler.ts` 側（`bedrockAgentCoreClient`/
 * `ListEventsCommand` と同じ、モジュールスコープでクライアントを1回だけ生成する
 * パターン）で行う。この分離により、Property 5（actor_id が一致しない場合、
 * Memory 取得呼び出し自体が発生しない）の PBT は、DynamoDB/AWS SDK の実際の
 * 呼び出しに依存せず `isSessionOwnedByActor` を直接検証できる。
 *
 * Requirements: 3.1, 3.2
 */

/**
 * 選択された Chat_Session の `ownerUserId`（DynamoDB の `GetItem` 結果から
 * 取得した値。レコードが存在しない場合は所有権を確認できないため `null`）と、
 * Bearer トークンから抽出した認証済みユーザーの actor_id を比較し、Memory の
 * `ListEvents` 呼び出しを実行してよいかを判定する。
 *
 * - `sessionOwnerUserId` が `null`（Chat_Session レコードが存在しない、または
 *   `ownerUserId` フィールドを読み取れなかった）場合は許可しない
 *   （Requirement 3.2 の「actor_id が異なる」場合の一種として扱う。所有権を
 *   確認できない以上、一致していると見なす根拠がないため）。
 * - `sessionOwnerUserId` と `actorId` が一致する場合のみ許可する。
 *
 * 例外を投げない純粋関数であり、入力の組み合わせに関わらず常に `boolean` を
 * 返す。
 *
 * Validates: Requirements 3.2
 */
export function isSessionOwnedByActor(sessionOwnerUserId: string | null, actorId: string): boolean {
  return sessionOwnerUserId !== null && sessionOwnerUserId === actorId;
}
