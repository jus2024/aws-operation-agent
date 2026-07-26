"use client";

import { useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import { generateSessionName, DEFAULT_SESSION_NAME } from "./sessionNameResolver";

/**
 * セッション名自動生成フック（Memory ベースのチャット履歴移行に伴う新しい検知方式）
 *
 * 検知方式（design.md の「未確定事項」を実装フェーズで確定）: `@copilotkit/react-ui`
 * の `CopilotChat` コンポーネントが提供する `onSubmitMessage` プロップに直接フックする
 * （設計判断: 案 B「送信ハンドラーへの直接フック」を採用）。
 *
 * 選定理由（実際にインストールされているパッケージの型定義・実装を調査して確定）:
 * - 検討した代替案 A（CopilotKit v2 の `useAgent()` + `agent.subscribe({ onNewMessage })`
 *   を、`useChatSessionPersistence.ts` とは別の新規フックとして独立に購読する方式）は、
 *   `useChatSessionPersistence.ts` の既存コメントが明記する既知の重複発火バグ
 *   （ag_ui_strands の `emit_messages_snapshot` が 1 回のエージェント実行中に
 *   MESSAGES_SNAPSHOT イベントを複数回送信し、`onNewMessage` が同一メッセージに対して
 *   複数回発火する問題）を再び踏むリスクがあるため採用しなかった。
 * - 採用した代替案 B: `node_modules/@copilotkit/react-ui/dist/index.d.cts` で確認した
 *   `CopilotChatProps.onSubmitMessage?: (message: string) => void | Promise<void>` は、
 *   `node_modules/@copilotkit/react-core/dist/index.mjs` の `useCopilotChatInternal`
 *   （`latestSendMessageFunc`）内で、ユーザーが送信した生テキストを引数に、
 *   `agent.addMessage()` および `copilotkit.runAgent()` の呼び出しより前に
 *   一度だけ呼び出されることをソースコードで確認済み。CopilotKit 内部の
 *   スナップショット再送信の影響を受けない、ユーザーの送信操作そのものに
 *   直接フックする方式であるため、こちらを採用する。
 *
 * 重要な分離: このフックが行うのは DynamoDB（`ChatSession.sessionName`、
 * `renameSession` 経由）への書き込みのみである。AgentCore Memory への発言内容の
 * 記録は AgentCore Runtime 側の既存の仕組みで自動的に行われるものであり
 * （Requirement 1.1）、このフックは Memory への読み書きに一切関与しない。
 * Memory（会話内容の唯一の正）と DynamoDB の ChatSession メタデータ管理は、
 * 本フックの実装後も完全に独立した経路のままである（Requirement 1.3）。
 *
 * 現行の `useChatSessionPersistence.ts` の `onNewMessage` 購読内にも同種の
 * セッション名自動生成ロジックが残っているが（タスク 7.1 で削除予定）、
 * 両方とも同一の `DEFAULT_SESSION_NAME` ガードを使うため、どちらが先に実行されても
 * 生成される名前は同じ入力（同じ送信テキスト）から計算され同一になる。
 * 二重に `renameSession` が呼ばれる可能性はあるが、結果は冪等（同じ名前を
 * 上書きするだけ）であり、表示される名前が不正な状態になることはない。
 *
 * Requirements: 1.2, 1.3
 */

interface UseSessionNameAutoGenerationParams {
  activeSessionId: string | null;
  renameSession: (id: string, name: string) => Promise<unknown>;
}

interface UseSessionNameAutoGenerationResult {
  /** `CopilotChat` の `onSubmitMessage` プロップに渡すハンドラー */
  handleSubmitMessage: (messageText: string) => Promise<void>;
}

export function useSessionNameAutoGeneration({
  activeSessionId,
  renameSession,
}: UseSessionNameAutoGenerationParams): UseSessionNameAutoGenerationResult {
  const handleSubmitMessage = useCallback(
    async (messageText: string) => {
      if (!activeSessionId) return;

      try {
        const client = generateClient<Schema>();
        const { data: currentSession } = await client.models.ChatSession.get({
          id: activeSessionId,
        });

        // セッション名がデフォルト名のままの場合のみ自動生成する。
        // 手動リネーム済み、または既に自動生成済みなら上書きしない
        // （このガードにより、2件目以降のメッセージ送信時は何もしない）。
        if (currentSession?.sessionName === DEFAULT_SESSION_NAME) {
          // DynamoDB の ChatSession.sessionName を更新する（AgentCore Memory
          // への書き込みではない。上部コメント参照）。
          await renameSession(activeSessionId, generateSessionName(messageText));
        }
      } catch (err) {
        // ベストエフォート: セッション名自動生成の失敗はチャット送信自体をブロックしない
        console.error("[useSessionNameAutoGeneration] セッション名自動生成エラー:", err);
      }
    },
    [activeSessionId, renameSession],
  );

  return { handleSubmitMessage };
}
