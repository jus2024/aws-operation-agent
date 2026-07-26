"use client";

import { useCallback } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import {
  prepareOutgoingContent,
  stripHistoricalImageContent,
  type SendableImageAttachment,
} from "./outgoingImageMessage";
import type { ImageAttachmentError } from "./imageAttachment";

/**
 * useImageMessageSender — 受理済み画像添付を multimodal メッセージとして送出する配線
 *
 * Composer（`ImageAttachmentComposer`）が受理した添付（`file` を保持する
 * `PendingImageAttachment[]` 等）を、CopilotKit v2 / AG-UI の multimodal ユーザー
 * メッセージ（text + base64 image blocks）へ変換し、既存の `useAgent` エージェント
 * 経由で送出する。接続構成（`/api/copilotkit` + SigV4 + HttpAgent → AgentCore）は
 * 一切変更しない（Req 8.3, 8.7）。import は `@copilotkit/react-core/v2` のみ（Req 8.2）。
 *
 * 送出前に:
 *   - 過去ターンの画像バイナリをスレッドから strip して再送しない（Req 9.9）。
 *   - 各添付を base64 化し、合計ペイロードを実効転送上限で見積る。エンコード失敗・
 *     上限超過はエラー理由を返し、添付を黙って落とさない（Req 9.6, 9.8）。呼び出し側
 *     （Composer）が `role="alert"` 等で表示する。
 *
 * 本フックは `CopilotKit`（`CopilotProvider`）配下で呼び出すこと。
 *
 * Requirements: 9.6, 9.8, 9.9, 8.7, 8.2, 8.3
 */

export type SendImageMessageResult =
  | { ok: true }
  | { ok: false; reason: ImageAttachmentError | "agent_unavailable" };

export interface UseImageMessageSenderResult {
  /**
   * テキストと受理済み添付から multimodal メッセージを構築して送出する。
   * 成功なら `{ ok: true }`、失敗なら理由付き `{ ok: false }` を返す
   * （呼び出し側はエラー表示し、添付を保持したままにする）。
   */
  send: (
    text: string,
    attachments: SendableImageAttachment[],
  ) => Promise<SendImageMessageResult>;
}

/** メッセージ ID を生成する（crypto.randomUUID が無い環境向けフォールバック付き）。 */
function generateMessageId(): string {
  const c: Crypto | undefined =
    typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useImageMessageSender(
  agentId = "sample_agent",
): UseImageMessageSenderResult {
  const { agent } = useAgent({ agentId });

  const send = useCallback(
    async (
      text: string,
      attachments: SendableImageAttachment[],
    ): Promise<SendImageMessageResult> => {
      // base64 化 + 転送量見積り。エンコード失敗/上限超過はここで表面化させ、
      // 添付を黙って落とさない（Req 9.8）。
      const prepared = await prepareOutgoingContent({ text, attachments });
      if (!prepared.ok) {
        return { ok: false, reason: prepared.reason };
      }

      if (!agent) {
        return { ok: false, reason: "agent_unavailable" };
      }

      // Req 9.9: 送信直前に過去ターンの画像バイナリをスレッドから除去し、
      // 現在ターンの画像のみをインライン送出する（ペイロード肥大を防止）。
      agent.setMessages(stripHistoricalImageContent(agent.messages));

      agent.addMessage({
        id: generateMessageId(),
        role: "user",
        content: prepared.content,
      });

      await agent.runAgent();
      return { ok: true };
    },
    [agent],
  );

  return { send };
}
