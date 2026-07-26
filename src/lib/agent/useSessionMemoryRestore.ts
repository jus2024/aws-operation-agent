"use client";

import { useCallback, useEffect, useState } from "react";
import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { fetchAuthSession } from "aws-amplify/auth";
import type { Message } from "@ag-ui/client";
import { useMessageTimestamp } from "@/src/components/agent/MessageTimestampContext";

/**
 * AgentCore Memory ベースのセッション履歴復元フック
 *
 * `activeSessionId` が変わるたびに Memory 読み出しエンドポイント
 * （`GET {functionUrl}/memory/events?sessionId=...`、
 * `amplify/functions/copilotkitStreamingRelay/handler.ts` の
 * `handleMemoryRestoreRequest`）を呼び出し、レスポンスの `messages` を
 * `agent.setMessages()` に渡して会話履歴を復元する。
 *
 * - Memory 側の状態を変更しない読み取り専用操作のため、
 *   `useChatSessionPersistence.ts` の `persistedContentKeysRef` のような
 *   重複ガードは実装しない（同一セッションを何度開いても Memory 側の
 *   結果は変化しないため、そのまま `setMessages()` に渡せば冪等になる）。
 * - `sessionId` に対応する Memory_Event が0件の場合も `agent.setMessages([])`
 *   を呼び、前のセッションの表示が残らないようにする（Requirement 2.4）。
 * - 取得失敗時（Requirement 2.5）は `agent.setMessages(...)` を呼ばず
 *   （既存の表示を破棄せず、偽のエラーメッセージもチャットに挿入しない）、
 *   エラー状態を呼び出し元（`page.tsx`、タスク 6.1 で結線予定）に伝える。
 *   `retry()` で同じ `activeSessionId` に対して再試行できる。
 * - `activeSessionId` が高速に切り替わった場合の競合を防ぐため、
 *   `page.tsx` の既存の `useEffect` と同じ `let cancelled = false` パターンを
 *   使う（古いセッション向けの遅いレスポンスが、新しいセッションの表示を
 *   上書きしないようにする）。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

interface UseSessionMemoryRestoreParams {
  activeSessionId: string | null;
}

interface UseSessionMemoryRestoreResult {
  isLoading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Memory 読み出しエンドポイントのレスポンス型に含まれる AG-UI Message の
 * 判別可能なユニオン。design.md の Data Models セクションで定義された
 * `AGUIMessage`（バックエンド `amplify/functions/copilotkitStreamingRelay/memoryRestore.ts`
 * の型）と同一の形状。
 */
/**
 * 復元時のユーザーマルチモーダルコンテンツブロック。バックエンド
 * （`amplify/functions/copilotkitStreamingRelay/memoryRestore.ts` の `UserContentBlock`）
 * と同一形状で、送信時（`outgoingImageMessage.ts`）の multimodal 形状にそろえる。
 */
export type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "data"; value: string; mimeType: string };
    };

export type AGUIMessage =
  | { id: string; role: "user" | "assistant"; content: string; createdAt?: number }
  | { id: string; role: "user"; content: UserContentBlock[]; createdAt?: number }
  | {
      id: string;
      role: "assistant";
      toolCallId: string;
      toolCallName: string;
      toolCallArgs: Record<string, unknown>;
      createdAt?: number;
    }
  | { id: string; role: "tool"; toolCallId: string; content: string; createdAt?: number };

/**
 * `GET {functionUrl}/memory/events?sessionId=...` のレスポンス型（成功時）。
 *
 * バックエンド（`handleMemoryRestoreRequest`）はサーバー側で ListEvents の
 * 全ページを取得し、選択セッションの完全なトランスクリプトを1回で返すため、
 * レスポンスに `nextToken` は含まれない（クライアント側ページングは行わない）。
 */
interface MemoryRestoreResponse {
  messages: AGUIMessage[];
}

/** `GET {functionUrl}/memory/events?sessionId=...` のレスポンス型（失敗時） */
interface MemoryRestoreErrorResponse {
  error: string;
}

/**
 * Memory 読み出しエンドポイントの URL を組み立てる純粋関数。
 *
 * `NEXT_PUBLIC_COPILOTKIT_RELAY_URL`（Lambda 関数 URL）は末尾にスラッシュを
 * 含む形式（例: `https://xxxx.lambda-url.us-west-2.on.aws/`）で管理されている
 * （`.env.local` 参照）。`handler.ts` 側のパスは `/memory/events`（先頭スラッシュ
 * なしで見ると `memory/events`）であるため、`new URL(path, base)` を使い、
 * ベース URL の末尾スラッシュの有無に関わらず正しく1つのスラッシュで
 * 連結されるようにする（末尾スラッシュが欠けている場合に備えて明示的に
 * 補完する）。`URLSearchParams` でクエリパラメータを付与するため、
 * `sessionId` の URL エンコードも自動的に行われる。
 *
 * 手動の文字列結合ではなく `URL`/`URLSearchParams` を使う方が、
 * スラッシュの欠落・重複やエンコードミスを構造的に防げるため、
 * こちらを採用した。
 */
export function buildMemoryRestoreUrl(
  functionUrl: string,
  sessionId: string,
  nextToken?: string,
): string {
  const normalizedBase = functionUrl.endsWith("/") ? functionUrl : `${functionUrl}/`;
  const url = new URL("memory/events", normalizedBase);
  url.searchParams.set("sessionId", sessionId);
  if (nextToken) {
    url.searchParams.set("nextToken", nextToken);
  }
  return url.toString();
}

/**
 * バックエンドの `AGUIMessage` 1件を、`@ag-ui/client`（`AbstractAgent.setMessages()`）
 * が要求する `Message` 型（`@ag-ui/core` の判別可能ユニオン）に変換する純粋関数。
 *
 * マッピング方針:
 * - テキストメッセージ（`role` が `"user"`/`"assistant"` で `content: string` のみ）は、
 *   そのまま `UserMessage`/`AssistantMessage`（`content` フィールドのみ設定）に変換する。
 * - tool call メッセージ（`role: "assistant"` に `toolCallId`/`toolCallName`/`toolCallArgs`
 *   を持つもの）は `AssistantMessage` に変換する。`@ag-ui/core` の `AssistantMessage` は
 *   複数の tool call を1つの `toolCalls: ToolCall[]` 配列にまとめる形状だが、
 *   バックエンドは `toolUseId` 単位で1メッセージずつ返すため、要素数1の
 *   `toolCalls` 配列として表現する。`ToolCall` は
 *   `{ id, type: "function", function: { name, arguments } }` という形状であり、
 *   `arguments` は文字列（JSON 文字列化された引数）である必要があるため、
 *   `toolCallArgs`（`Record<string, unknown>`）を `JSON.stringify()` する。
 * - tool result メッセージ（`role: "tool"`）は `ToolMessage`
 *   （`{ id, role: "tool", toolCallId, content }`）にそのまま変換する。
 *
 * 参照した型定義: `@ag-ui/client`（`node_modules/@ag-ui/client/dist/index.d.ts`、
 * `@ag-ui/core` を re-export）の `AssistantMessageSchema`/`UserMessageSchema`/
 * `ToolMessageSchema`（`Message` 判別可能ユニオンの構成要素）。
 */
export function mapAGUIMessageToClientMessage(message: AGUIMessage): Message {
  if (message.role === "tool") {
    return {
      id: message.id,
      role: "tool",
      toolCallId: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === "assistant" && "toolCallId" in message) {
    return {
      id: message.id,
      role: "assistant",
      toolCalls: [
        {
          id: message.toolCallId,
          type: "function",
          function: {
            name: message.toolCallName,
            arguments: JSON.stringify(message.toolCallArgs ?? {}),
          },
        },
      ],
    };
  }

  // text メッセージ、および画像ユーザーターンの構造化配列コンテンツ
  // （`UserContentBlock[]`）はいずれも `content` をそのまま渡す。配列コンテンツは
  // `ChatUserMessage` の `parseUserMessageContent`（配列分岐）がテキスト+サムネイルへ
  // 描画し、再送時は `stripHistoricalImageContent` が画像ブロックを除去する。
  return {
    id: message.id,
    role: message.role,
    content: message.content,
  } as Message;
}

export function useSessionMemoryRestore({
  activeSessionId,
}: UseSessionMemoryRestoreParams): UseSessionMemoryRestoreResult {
  const { agent } = useAgent({
    agentId: "sample_agent",
    updates: [UseAgentUpdate.OnMessagesChanged],
  });

  // 復元メッセージの `createdAt`（AgentCore Memory の eventTimestamp 由来の
  // 正確な記録時刻）をメッセージ単位タイムスタンプ・レジストリへ登録する。
  // このフックは MessageTimestampProvider 配下で実行されるためコンテキストを
  // 直接参照する（プロバイダー外なら null で、その場合は登録をスキップする）。
  const timestampRegistry = useMessageTimestamp();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // retry() が同じ activeSessionId に対して再度フェッチを発火させるための
  // トリガー用カウンタ（useEffect の依存配列に含める）。
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    // `activeSessionId` は関数パラメータのため、TypeScript は入れ子の
    // `async function restore()` 内でこの null チェックによる型の絞り込みを
    // 保持しない（別スコープの関数から再代入される可能性を考慮するため）。
    // 絞り込み済みの値を別の const に固定してから内部関数で使う。
    const sessionId = activeSessionId;
    let cancelled = false;

    async function restore() {
      setIsLoading(true);
      setError(null);

      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.accessToken?.toString();
        if (!token) {
          if (!cancelled) {
            setError("認証情報を取得できませんでした。");
            setIsLoading(false);
          }
          return;
        }

        const functionUrl = process.env.NEXT_PUBLIC_COPILOTKIT_RELAY_URL;
        if (!functionUrl) {
          if (!cancelled) {
            setError("Memory 読み出しエンドポイントが設定されていません。");
            setIsLoading(false);
          }
          return;
        }

        const url = buildMemoryRestoreUrl(functionUrl, sessionId);
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (cancelled) return;

        if (!response.ok) {
          setError("会話履歴の取得に失敗しました。");
          setIsLoading(false);
          return;
        }

        const body = (await response.json()) as
          | MemoryRestoreResponse
          | MemoryRestoreErrorResponse;

        if (cancelled) return;

        if ("error" in body) {
          setError(body.error);
          setIsLoading(false);
          return;
        }

        if (agent) {
          // setMessages より前に登録することで、直後にライブ検知（first-seen）が
          // 走っても復元の正確な時刻が先勝ちで保持される（上書きされない）。
          if (timestampRegistry) {
            for (const message of body.messages) {
              if (typeof message.createdAt === "number") {
                timestampRegistry.registerTimestamp(message.id, message.createdAt);
              }
            }
          }
          agent.setMessages(body.messages.map(mapAGUIMessageToClientMessage));
        }
        setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error("[useSessionMemoryRestore] 会話履歴の復元エラー:", err);
          setError("会話履歴の取得中にエラーが発生しました。");
          setIsLoading(false);
        }
      }
    }

    restore();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, agent, retryToken, timestampRegistry]);

  const retry = useCallback(() => {
    setRetryToken((current) => current + 1);
  }, []);

  return { isLoading, error, retry };
}
