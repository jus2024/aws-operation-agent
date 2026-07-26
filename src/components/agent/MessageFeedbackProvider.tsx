"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  AssistantMessage as DefaultAssistantMessage,
  type AssistantMessageProps,
} from "@copilotkit/react-ui";
import { FeedbackCommentDialog } from "./FeedbackCommentDialog";
import { useMessageFeedback } from "@/src/lib/agent/feedback/useMessageFeedback";
import type { FeedbackState } from "@/src/lib/agent/feedback/feedbackState";
import { useMessageTime, useIsFirstOfDay } from "./MessageTimestampContext";
import { BotIcon } from "./AgentIcons";
import {
  formatMessageTime,
  formatMessageDate,
  toLocalDayKey,
} from "@/src/lib/agent/messageTime";

/**
 * MessageFeedbackProvider — Feedback フローの配線（Option A: CopilotKit ビルトイン）
 *
 * 状態遷移・永続化ロジック（`useMessageFeedback` / 純粋リデューサ
 * `nextFeedbackState`）と `FeedbackCommentDialog` を 1 つのフローに結線し、
 * **CopilotKit のビルトインメッセージコントロール**（既定 `AssistantMessage` の
 * thumbs up/down）へ配線する。
 *
 * 設計変更 (Option A):
 * 当初は独自の `FeedbackControl`（Good/Bad）と `MessageActionRow`（再生成 +
 * コピー + Good/Bad を束ねる行）を描画していたが、CopilotKit 既定の操作行と
 * 二重に重なって表示される不具合が生じたため、独自コントロールを廃し
 * CopilotKit ビルトインへ一本化した。既定 `AssistantMessage` は単一の操作行に
 * 再生成 + コピーを常に描画し、`onThumbsUp`/`onThumbsDown` が渡されたときのみ
 * thumbs up/down を追加描画して `feedback`（"thumbsUp" | "thumbsDown" | null）に
 * 応じてハイライトする。
 *
 * 配線内容:
 * - **Bad 押下 → コメントダイアログ起動**: Bad を押して結果が "bad"（none/good
 *   からの遷移）になるときに `FeedbackCommentDialog` を開く（Req 3.1）。すでに
 *   "bad" のときに Bad を再押下した場合はクリアなのでダイアログは開かない。
 * - **sentiment 遷移（good⇔bad / 同一押下でクリア）**: 押下は
 *   `useMessageFeedback.recordFeedback` に委譲し、遷移判定は純粋リデューサ
 *   `nextFeedbackState` が行う（Req 2.2, 2.3, 2.4, 2.5）。
 * - **bad→good / クリア時のコメント削除**: `nextFeedbackState` が comment を
 *   破棄し、`useMessageFeedback` が該当レコードを update/delete する（Req 3.6）。
 * - **永続化エラーインジケーター（`role="alert"`）**: 記録/更新/クリアが失敗した
 *   場合、`useMessageFeedback` が最後に永続化成功した状態へロールバックし、本
 *   プロバイダーが `role="alert"` の非破壊的な通知を表示する（Req 2.7）。
 *
 * 実装方針（`amplify-frontend` ルール: UI ロジックとインフラの分離）:
 * - 永続化・状態遷移は `useMessageFeedback` / `nextFeedbackState` に閉じ込め、
 *   本コンポーネントは「ビルトインコントロールへの配線」と「ダイアログ/エラーの
 *   提示」に徹する。
 * - CopilotChat へは、モジュールスコープで安定した `FeedbackAssistantMessage`
 *   を `AssistantMessage` プロップとして渡す。フィードバック状態は React context
 *   を介して供給するため、状態更新時にメッセージ行が再マウントされない。
 * - import は UI 部品のみを `@copilotkit/react-ui` から取得し、接続構成
 *   （`/api/copilotkit` + SigV4 + HttpAgent）は一切変更しない（Req 8.3）。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9, 2.10, 3.6, 7.5
 */

interface MessageFeedbackContextValue {
  /** 指定メッセージの現在の Feedback 状態（楽観的更新を反映） */
  getFeedback: (messageId: string) => FeedbackState;
  /** Good ボタン押下 */
  onGood: (messageId: string) => void;
  /** Bad ボタン押下（結果が "bad" ならコメントダイアログを開く） */
  onBad: (messageId: string) => void;
  /** 現在永続化中の messageId（ボタン無効化用）。無ければ null */
  pendingMessageId: string | null;
}

const MessageFeedbackContext =
  createContext<MessageFeedbackContextValue | null>(null);

/**
 * CopilotChat の `AssistantMessage` プロップへ渡す、フィードバック配線済みの
 * 薄いラッパー（Option A）。
 *
 * CopilotKit 既定の `AssistantMessage`（`DefaultAssistantMessage`）をそのまま
 * 描画しつつ、次のプロップだけを注入する:
 * - `feedback`: `useMessageFeedback` の `Feedback_Sentiment` を
 *   good→"thumbsUp" / bad→"thumbsDown" / null→null にマップして注入する
 *   （既定描画が thumbs をハイライトし 3 状態を視覚区別する。Req 2.6）。
 * - `onThumbsUp` / `onThumbsDown`: context の `onGood` / `onBad` へ配線する
 *   （既定描画がこの 2 つを受け取ったときのみ Good/Bad ボタンを操作行へ追加
 *   描画する。Req 2.1, 2.8）。再生成・コピーは既定コントロールが担う
 *   （Req 2.9, 2.10）。
 *
 * モジュールスコープで一度だけ定義することで、フィードバック状態が変化しても
 * コンポーネント同一性が保たれ、CopilotChat がメッセージ行を再マウントしない。
 * フィードバック状態・ハンドラは context から取得する。
 *
 * `MessageFeedbackProvider` の外で使われた場合（context が null）や、生成途中 /
 * messageId 未確定のときは、フィードバック配線を付けず既定描画のみを行う
 * （その場合でも既定コントロールの再生成・コピーはそのまま機能する）。
 */
export function FeedbackAssistantMessage(props: AssistantMessageProps) {
  const ctx = useContext(MessageFeedbackContext);
  const id = props.message?.id;

  // 生成完了（LLM が応答を出し終えた）アシスタントメッセージのみを操作対象にする。
  const isComplete = !props.isLoading && !props.isGenerating;

  // プロバイダー配下で messageId が確定し、生成完了しているときのみ Good/Bad を
  // 配線する（Req 2.1）。生成途中や id 未確定時はフィードバック配線を付けない。
  const canFeedback =
    ctx !== null && typeof id === "string" && id.length > 0 && isComplete;

  // Feedback_Sentiment → CopilotKit の feedback プロップへマップ（Req 2.6）。
  const sentiment = canFeedback ? ctx.getFeedback(id).sentiment : null;
  const feedback: AssistantMessageProps["feedback"] =
    sentiment === "good"
      ? "thumbsUp"
      : sentiment === "bad"
        ? "thumbsDown"
        : null;

  // タイムスタンプ: AIMessage 型に作成時刻フィールドが無いため、メッセージ単位
  // タイムスタンプ・レジストリ（MessageTimestampContext）から props.message?.id で
  // 表示時刻を引く。復元ターンは Memory の eventTimestamp 由来、ライブターンは
  // 初回観測時刻（first-seen）が登録される。時刻が無い場合（CopilotChat の初期
  // グリーティングや id 未確定メッセージ）は何も描画しない（捏造しない）。
  const timestamp = useMessageTime(id);
  const time = timestamp !== undefined ? formatMessageTime(timestamp) : "";

  // 暦日の最初のメッセージのときは、行の上に日付区切りを描画する。
  // 時刻が無い（id 未確定・初期グリーティング等）場合は日付を捏造しないため描画しない。
  const isFirstOfDay = useIsFirstOfDay(id);
  const dayLabel =
    isFirstOfDay && timestamp !== undefined ? formatMessageDate(timestamp) : "";
  // 浮遊日付ヘッダー（ChatStickyDateHeader）が暦日境界を検知しラベルを読むための属性。
  const dayKey =
    isFirstOfDay && timestamp !== undefined ? toLocalDayKey(timestamp) : "";

  // mocks/chat.html の `.msg.msg--assistant`（アバター + 著者名メタ + 本文）に
  // 準拠したスキャフォールドで既定描画を包む。CopilotKit ビルトインの操作行
  // （再生成・コピー・thumbs up/down）は DefaultAssistantMessage がそのまま
  // 描画するため、Option A の挙動は完全に維持される。日付区切りは行の上に
  // フラグメントで並置する。
  return (
    <>
      {dayLabel && (
        <div className="chat-day-divider" data-day-key={dayKey} data-date={dayLabel}>
          <span>{dayLabel}</span>
        </div>
      )}
      <article className="msg msg--assistant">
        <div className="msg__avatar msg__avatar--assistant" aria-hidden="true">
          <BotIcon className="msg__avatar-icon" />
        </div>
        <div className="msg__body">
          <div className="msg__meta">
            <span className="msg__author">アシスタント</span>
            {time && <span className="msg__time">{time}</span>}
          </div>
          <DefaultAssistantMessage
            {...props}
            feedback={feedback}
            onThumbsUp={canFeedback ? () => ctx.onGood(id) : props.onThumbsUp}
            onThumbsDown={canFeedback ? () => ctx.onBad(id) : props.onThumbsDown}
          />
        </div>
      </article>
    </>
  );
}

export interface MessageFeedbackProviderProps {
  /** 現在認証中ユーザーの Cognito sub。未認証時は null（記録不可） */
  ownerUserId: string | null;
  /** 現在アクティブな Chat_Session の id（Feedback レコードに紐づく） */
  chatSessionId: string;
  children: ReactNode;
}

export function MessageFeedbackProvider({
  ownerUserId,
  chatSessionId,
  children,
}: MessageFeedbackProviderProps) {
  const feedback = useMessageFeedback(ownerUserId);

  // Bad 評価直後にコメント入力を促すダイアログ対象の messageId。null = 非表示。
  const [commentDialogMessageId, setCommentDialogMessageId] = useState<
    string | null
  >(null);

  const onGood = (messageId: string) => {
    // 遷移判定は nextFeedbackState（recordFeedback 内）に委譲する。
    void feedback.recordFeedback(messageId, chatSessionId, "good");
  };

  const onBad = (messageId: string) => {
    // 現在 "bad" でなければ、この押下で "bad" へ遷移する（Req 2.3, 2.4）。
    // その場合のみ、コメント入力ダイアログを開く（Req 3.1）。すでに "bad" の
    // 場合は再押下でクリア（Req 2.5）となるためダイアログは開かない。
    const willBecomeBad = feedback.getFeedback(messageId).sentiment !== "bad";
    void feedback.recordFeedback(messageId, chatSessionId, "bad");
    if (willBecomeBad) {
      setCommentDialogMessageId(messageId);
    }
  };

  const contextValue: MessageFeedbackContextValue = {
    getFeedback: feedback.getFeedback,
    onGood,
    onBad,
    pendingMessageId: feedback.pendingMessageId,
  };

  const handleCommentSubmit = (comment: string | undefined) => {
    // 非空コメントは "bad" レコードへ付与（Req 3.3）。空なら comment 無しで維持
    // （Req 3.2, 3.4）。付与判定・no-op は updateComment に委譲する。
    if (commentDialogMessageId) {
      void feedback.updateComment(
        commentDialogMessageId,
        chatSessionId,
        comment ?? null,
      );
    }
    setCommentDialogMessageId(null);
  };

  const handleCommentCancel = () => {
    // キャンセル時は "bad" 評価をコメント無しで維持する（Req 3.4）。
    setCommentDialogMessageId(null);
  };

  return (
    <MessageFeedbackContext.Provider value={contextValue}>
      {children}

      <FeedbackCommentDialog
        isOpen={commentDialogMessageId !== null}
        onSubmit={handleCommentSubmit}
        onCancel={handleCommentCancel}
      />

      {/* 永続化エラーの非破壊的インジケーター（Req 2.7）。UI 状態は
          useMessageFeedback 側で最後に永続化成功した状態へロールバック済み。 */}
      {feedback.error && (
        <div
          role="alert"
          style={{
            position: "fixed",
            bottom: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1100,
            maxWidth: "32rem",
            padding: "0.625rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid #fca5a5",
            backgroundColor: "#fef2f2",
            color: "#991b1b",
            fontSize: "0.8rem",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
          }}
        >
          フィードバックの保存に失敗しました。もう一度お試しください。
        </div>
      )}
    </MessageFeedbackContext.Provider>
  );
}

export default MessageFeedbackProvider;
