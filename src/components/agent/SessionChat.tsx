"use client";

import {
  CopilotChat,
  type AssistantMessageProps,
  type InputProps,
  type UserMessageProps,
} from "@copilotkit/react-ui";
import type { ComponentType } from "react";
import "@copilotkit/react-ui/styles.css";
import "./copilot-chat.css";
import { SessionHeader, type RoleChip } from "./SessionHeader";
import { ChatUserMessage } from "./ChatUserMessage";
import { ChatStickyDateHeader } from "./ChatStickyDateHeader";

/**
 * SessionChat — セッション固定チャットコンポーネント
 *
 * SessionHeader（Role_Set の複数チップ表示ヘッダー）+ CopilotChat を結合し、
 * セッション中のチャット UI を構成する。
 *
 * エラー状態（Role_Set 全欠落 / コンテキスト読込失敗 / 過去セッション復元失敗）時は:
 *   - エラーメッセージを表示
 *   - チャット入力を無効化
 *   - 「新規セッション」ボタンで回復を提供
 *
 * `roleChips` のうち `missing: true` のチップは、SessionHeader 側で
 * 「元のロールが見つかりません」という欠落インジケーターとして個別に表示される
 * （Requirement 3.5, 3.6）。
 *
 * Requirements: 3.5, 3.6
 */

export interface SessionChatProps {
  /** 現在の Role_Set を表す RoleChip の一覧（欠落中のロールは missing: true） */
  roleChips: RoleChip[];
  /** 新規セッション開始コールバック */
  onNewSession: () => void;
  /** エラー状態: Role_Set 全欠落やコンテキスト読込失敗時に設定 */
  error?: string | null;
  /**
   * エラー状態からの回復操作を「新規セッション」開始ではなく再試行にしたい場合の
   * コールバック（例: Memory からの会話履歴取得失敗時、`useSessionMemoryRestore`
   * の `retry()`）。指定された場合、エラーパネルのボタンはこのコールバックを
   * 呼び出し、ラベルも `retryLabel`（既定値「再試行」）に切り替わる。
   * 未指定の場合は既存の挙動（`onNewSession` を呼び「新規セッション」と表示）
   * を維持する。
   */
  onRetry?: () => void;
  /** `onRetry` 指定時のボタンラベル（既定値: 「再試行」） */
  retryLabel?: string;
  /**
   * ユーザーがメッセージを送信した直後（エージェント実行開始前）に一度だけ
   * 呼び出されるコールバック（`@copilotkit/react-ui` の `CopilotChat` が提供する
   * `onSubmitMessage` プロップをそのまま中継する）。セッション名自動生成
   * （`useSessionNameAutoGeneration`）の検知トリガーとして使う想定。
   */
  onSubmitMessage?: (message: string) => void | Promise<void>;
  /**
   * CopilotChat のアシスタントメッセージ描画を差し替えるカスタムコンポーネント。
   * Feedback_Control を各アシスタントメッセージへ統合するために使用する
   * （`MessageFeedbackProvider` の `FeedbackAssistantMessage`）。未指定時は
   * CopilotKit 既定のアシスタントメッセージ描画を用いる（Req 2.1）。
   */
  AssistantMessage?: ComponentType<AssistantMessageProps>;
  /**
   * CopilotChat のユーザーメッセージ描画を差し替えるカスタムコンポーネント。
   * 未指定時は mocks/chat.html に準拠した `ChatUserMessage`（アバター + 著者名 +
   * バブルの左並び行）を用いる（Req 6.1）。
   */
  UserMessage?: ComponentType<UserMessageProps>;
  /**
   * CopilotChat の入力欄（コンポーザ）を差し替えるカスタム Input コンポーネント。
   * 画像添付 UI（`ChatComposer`）をチャット入力に統合するために使用する。
   * 未指定時は CopilotKit 既定の入力欄を用いる（Req 9.1）。
   *
   * 注意: CopilotChat が Input を再マウントしないよう、呼び出し側は安定した
   * コンポーネント参照（モジュールスコープ or memo 化）を渡すこと。
   */
  Input?: ComponentType<InputProps>;
}

export function SessionChat({
  roleChips,
  onNewSession,
  error,
  onRetry,
  retryLabel = "再試行",
  onSubmitMessage,
  AssistantMessage,
  UserMessage = ChatUserMessage,
  Input,
}: SessionChatProps) {
  const hasError = !!error;
  const chatInitialLabel =
    roleChips.length > 0
      ? `ロール「${roleChips.map((c) => c.displayName).join(", ")}」で開始しました。何かお手伝いできることはありますか？`
      : "何かお手伝いできることはありますか？";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* 固定ヘッダー: Role_Set チップ表示。新規 Chat_Session 開始はサイドバーの
          「新規チャット」に一本化したため、ヘッダーの「新規セッション」ボタンは
          撤去した（Requirement 7.5, Task 6.6）。`onNewSession` はエラー状態からの
          回復導線でのみ使用する。 */}
      <SessionHeader roleChips={roleChips} />

      {/* エラー状態: ロール利用不可 / コンテキスト読込失敗 */}
      {hasError && (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            padding: "2rem",
            gap: "1rem",
          }}
        >
          <div
            style={{
              maxWidth: "28rem",
              textAlign: "center",
              padding: "1.5rem",
              borderRadius: "var(--radius, 0.5rem)",
              border: "1px solid var(--color-bad, #fca5a5)",
              backgroundColor: "var(--color-bad-surface, #fef2f2)",
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                width: "2.5rem",
                height: "2.5rem",
                color: "var(--color-bad, #dc2626)",
                margin: "0 auto 0.75rem",
              }}
              aria-hidden="true"
            >
              <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126Z" />
              <path d="M12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <p
              style={{
                fontSize: "0.9rem",
                color: "var(--color-bad, #991b1b)",
                marginBottom: "1rem",
                lineHeight: 1.5,
              }}
            >
              {error}
            </p>
            <button
              type="button"
              onClick={onRetry ?? onNewSession}
              style={{
                fontSize: "0.8rem",
                fontWeight: 500,
                padding: "0.5rem 1rem",
                borderRadius: "0.375rem",
                border: "none",
                backgroundColor: "var(--color-primary, #2563eb)",
                color: "#ffffff",
                cursor: "pointer",
                transition: "background-color 0.15s",
              }}
            >
              {onRetry ? retryLabel : "新規セッション"}
            </button>
          </div>
        </div>
      )}

      {/* 通常状態: CopilotChat。position: relative の枠を作り、スクロール領域
          （.copilotKitMessages）の最上部へ浮遊日付ヘッダー（ChatStickyDateHeader）を
          重ねる。ヘッダーは pointer-events: none でスクロール/入力を妨げない。 */}
      {!hasError && (
        <div
          style={{ flex: 1, overflow: "hidden", minHeight: 0, position: "relative" }}
        >
          <ChatStickyDateHeader />
          <CopilotChat
            className="session-chat"
            labels={{
              title: "AWS運用アシスタント",
              initial: chatInitialLabel,
              placeholder: "メッセージを入力...",
            }}
            onSubmitMessage={onSubmitMessage}
            AssistantMessage={AssistantMessage}
            UserMessage={UserMessage}
            Input={Input}
          />
        </div>
      )}
    </div>
  );
}

export default SessionChat;
