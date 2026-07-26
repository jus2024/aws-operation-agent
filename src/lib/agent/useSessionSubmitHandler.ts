"use client";

import { useCallback } from "react";
import { useSessionNameAutoGeneration } from "./useSessionNameAutoGeneration";

/**
 * メッセージ送信時のハンドラー合成フック
 *
 * `@copilotkit/react-ui` の `CopilotChat` が提供する `onSubmitMessage` プロップは
 * 単一のコールバックしか受け取れないため、ユーザーのメッセージ送信時に必要な
 * 2 つの独立した DynamoDB `ChatSession` メタデータ更新をここで 1 つのハンドラーに
 * 合成する:
 *
 *   (a) セッション名自動生成（`useSessionNameAutoGeneration`）
 *       — 最初のユーザーメッセージ送信時のみ `ChatSession.sessionName` を生成する。
 *   (b) セッションの updatedAt 更新（`touchSession`）
 *       — 毎回のユーザー送信で `ChatSession.update({ id })` を発行し、Amplify が
 *         自動付与する `ChatSession.updatedAt`（メタデータ）を更新する。これにより
 *         サイドバーの updatedAt-DESC 並び順で、直近に発言したセッションが次回の
 *         ロード/リフレッシュ時に先頭へ再ソートされる。
 *
 * 重要な分離: (a)(b) はいずれも DynamoDB の `ChatSession` メタデータ更新のみであり、
 * 発言内容の書き込み（`ChatMessage.create`）や AgentCore Memory への結合は一切
 * 行わない。発言内容の正のデータソースは AgentCore Memory に一本化されている
 * （Requirement 1.2, 1.3, 4.1）。(b) は、以前 `useChatSessionPersistence.ts` の
 * `onNewMessage` 購読（タスク 7.1 で削除済み）が付随的に提供していた updatedAt
 * 更新の挙動を、Memory への結合を復活させずに復元するものである。
 *
 * 実行順序（命名 → touch の逐次実行）: 命名は同一 `ChatSession` レコードに対して
 * `get` 後に条件付き `update({ id, sessionName })` を行い、touch は
 * `update({ id })` を行う。両者を並行発火させると `updatedAt`/`sessionName` に
 * 対する last-writer-wins の競合が起こりうるため、逐次実行して最終的な永続化
 * 状態を決定的にする。命名が実際に書き込むのは初回メッセージ時のみ（それ以降は
 * デフォルト名ガードで no-op）であり、touch は毎回書き込むため、逐次化のコストは
 * 小さい。
 *
 * 旧 `onNewMessage` 購読は user/assistant 両方のメッセージ永続化時に touch して
 * いたのに対し、本合成ハンドラーは `onSubmitMessage`（ユーザー送信時のみ発火）で
 * touch する。サイドバーの並び順の目的（アクティブなセッションを先頭に保つ）に
 * 対しては、各アシスタント応答の直前に必ずユーザーメッセージがあるため機能的に
 * 等価であり、むしろユーザーの操作そのものを反映する点で妥当である。
 *
 * Requirements: 1.2, 1.3
 */

interface UseSessionSubmitHandlerParams {
  activeSessionId: string | null;
  renameSession: (id: string, name: string) => Promise<unknown>;
  touchSession: (id: string) => Promise<void>;
}

interface UseSessionSubmitHandlerResult {
  /** `CopilotChat` の `onSubmitMessage` プロップに渡す合成ハンドラー */
  handleSubmitMessage: (messageText: string) => Promise<void>;
}

export function useSessionSubmitHandler({
  activeSessionId,
  renameSession,
  touchSession,
}: UseSessionSubmitHandlerParams): UseSessionSubmitHandlerResult {
  const { handleSubmitMessage: handleNameGeneration } = useSessionNameAutoGeneration({
    activeSessionId,
    renameSession,
  });

  const handleSubmitMessage = useCallback(
    async (messageText: string) => {
      // (a) セッション名自動生成（初回メッセージ時のみ実際に書き込む）
      await handleNameGeneration(messageText);

      // (b) updatedAt 更新（毎回のユーザー送信で書き込む）。touchSession は
      // ベストエフォート（内部でエラーをサイレントに無視する）。
      if (activeSessionId) {
        await touchSession(activeSessionId);
      }
    },
    [handleNameGeneration, touchSession, activeSessionId],
  );

  return { handleSubmitMessage };
}
