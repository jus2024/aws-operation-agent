"use client";

import type { UserMessageProps } from "@copilotkit/react-ui";
import { parseUserMessageContent } from "@/src/lib/agent/attachments/userMessageContent";
import { useMessageTime, useIsFirstOfDay } from "./MessageTimestampContext";
import { UserIcon } from "./AgentIcons";
import {
  formatMessageTime,
  formatMessageDate,
  toLocalDayKey,
} from "@/src/lib/agent/messageTime";

/**
 * base64 画像をデコードして Blob 化し、object URL を新規タブで開く。
 *
 * `data:` URL はトップレベルナビゲーション（新規タブ）がブラウザにブロックされる
 * ため、`<a href="data:">` や `window.open("data:...")` は使えない。base64 →
 * `Uint8Array` → `Blob`（MIME 付き）→ `URL.createObjectURL` で得た blob: URL を
 * `window.open(url, "_blank", "noopener,noreferrer")` で開く。URL は ~60 秒後に
 * revoke してメモリを解放する。SSR / 非ブラウザ環境では何もしない（ガード）。
 */
export function openImageInNewTab(mime: string, base64: string): void {
  if (typeof window === "undefined" || typeof atob === "undefined") {
    return;
  }
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // 新規タブが URL を読み込む猶予を与えてから解放する。
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    // デコード/生成失敗時は黙ってスキップ（バブル表示は維持）。
  }
}

/**
 * ChatUserMessage — CopilotChat の `UserMessage` プロップへ渡すカスタム描画。
 *
 * mocks/chat.html の `.msg.msg--user` を踏襲し、ユーザー発話を
 * アバター（"あなた" の頭文字相当）+ 著者名 + バブルの形で描画する。
 * CopilotKit 既定の右寄せ 1 行バブル（`.copilotKitUserMessage`）ではなく、
 * アシスタント側（`FeedbackAssistantMessage` のスキャフォールド）と対になる
 * 左並びのメッセージ行に統一する（Req 6.1）。
 *
 * 実装方針:
 * - 表示用のパースは純粋関数 `parseUserMessageContent` に委譲し、接続構成
 *   （`/api/copilotkit` + SigV4）やメッセージ状態管理には一切関与しない
 *   （UI ロジックとインフラの分離）。
 * - `message.content` は文字列またはマルチモーダルパーツ配列を取り得る。加えて
 *   画像添付ターンでは content が「content ブロック列の Python repr（生 base64 を含む）」
 *   の文字列として届くことがある。`parseUserMessageContent` が両形状から
 *   表示テキストと画像（base64）を抽出し、生 base64 / repr ノイズをバブルへ出さない。
 * - 画像は base64 から小さなサムネイル（`<img>`）として描画する。
 * - タイムスタンプ: UserMessage 型には作成時刻フィールドが無いため、メッセージ単位
 *   タイムスタンプ・レジストリ（`MessageTimestampContext`）から `message.id` で
 *   表示時刻を引く。復元ターンは Memory の eventTimestamp 由来、ライブターンは
 *   初回観測時刻（first-seen）が登録される。時刻が無い場合（id 未確定等）は何も
 *   描画しない（値を捏造しない）。
 *
 * スタイルは copilot-chat.css の `.msg` / `.msg__avatar` / `.msg__meta` /
 * `.msg__time` / `.bubble` / `.user-image-thumb` を共有 Design_Tokens 経由で適用する。
 */
export function ChatUserMessage({ message }: UserMessageProps) {
  const { text, images } = parseUserMessageContent(message?.content);
  const hasText = text.trim().length > 0;

  const timestamp = useMessageTime(message?.id);
  const time = timestamp !== undefined ? formatMessageTime(timestamp) : "";

  // 暦日の最初のメッセージのときは、行の上に日付区切りを描画する。
  // 時刻が無い（id 未確定・初期グリーティング等）場合は日付を捏造しないため描画しない。
  const isFirstOfDay = useIsFirstOfDay(message?.id);
  const dayLabel =
    isFirstOfDay && timestamp !== undefined ? formatMessageDate(timestamp) : "";
  // 浮遊日付ヘッダー（ChatStickyDateHeader）が暦日境界を検知しラベルを読むための属性。
  const dayKey =
    isFirstOfDay && timestamp !== undefined ? toLocalDayKey(timestamp) : "";

  return (
    <>
      {dayLabel && (
        <div className="chat-day-divider" data-day-key={dayKey} data-date={dayLabel}>
          <span>{dayLabel}</span>
        </div>
      )}
      <article className="msg msg--user">
        <div className="msg__avatar msg__avatar--user" aria-hidden="true">
          <UserIcon className="msg__avatar-icon" />
        </div>
        <div className="msg__body">
          <div className="msg__meta">
            <span className="msg__author">あなた</span>
            {time && <span className="msg__time">{time}</span>}
          </div>
          {hasText && <div className="bubble">{text}</div>}
          {images.length > 0 && (
            <div className="user-image-thumbs">
              {images.map((image, index) => (
                <button
                  // 添付画像はリストとして安定した順序で描画されるため index キーで十分。
                  key={index}
                  type="button"
                  className="user-image-thumb-button"
                  onClick={() => openImageInNewTab(image.mime, image.base64)}
                  aria-label="画像を拡大表示（別タブ）"
                  title="画像を拡大表示（別タブ）"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="user-image-thumb"
                    src={`data:${image.mime};base64,${image.base64}`}
                    alt="添付画像"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </article>
    </>
  );
}

export default ChatUserMessage;
