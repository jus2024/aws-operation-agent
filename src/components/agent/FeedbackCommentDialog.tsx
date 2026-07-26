"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  FEEDBACK_COMMENT_MAX,
  isValidComment,
} from "@/src/lib/agent/feedback/feedbackState";

/**
 * FeedbackCommentDialog — Bad 評価時に開く任意コメント入力ダイアログ
 *
 * ユーザーがアシスタントメッセージに Bad を付けた直後に表示され、悪かった点を
 * 任意で自由記述できる（Req 3.1）。コメントは任意であり、空のまま送信しても、
 * キャンセル（閉じる）しても Bad 評価はそのまま維持される（Req 3.2, 3.4）。
 * 送信時に非空のコメントがあれば呼び出し元へ渡して永続化させる（Req 3.3）。
 *
 * 文字数は最大 `FEEDBACK_COMMENT_MAX`（1000）文字に制限する。1000 文字を超えた
 * 場合は送信操作自体を無効化し、文字数上限のバリデーションメッセージを表示する
 * （Req 3.5）。判定ロジックは純粋関数 `isValidComment` に委譲する。
 *
 * `RoleSetSelectorDialog` と同じモーダルダイアログの慣習に従う:
 *  - オーバーレイクリック / Escape キーでキャンセル
 *  - 開いたときに入力欄へフォーカスを移す
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby` によるアクセシブルなラベル付け
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

export interface FeedbackCommentDialogProps {
  isOpen: boolean;
  /**
   * コメント付き（またはコメント無し）で Bad 評価を確定する。
   * 前後の空白を除いて非空のときのみコメント文字列を、空のときは undefined を渡す
   * （Req 3.2, 3.3）。
   */
  onSubmit: (comment: string | undefined) => void;
  /** ダイアログを閉じる / キャンセルする。Bad 評価はコメント無しで維持される（Req 3.4）。 */
  onCancel: () => void;
}

export function FeedbackCommentDialog({
  isOpen,
  onSubmit,
  onCancel,
}: FeedbackCommentDialogProps) {
  const [comment, setComment] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  // ダイアログが開くたびに入力欄をリセットする。
  useEffect(() => {
    if (isOpen) {
      setComment("");
    }
  }, [isOpen]);

  // Escape キーでキャンセルする（モーダルダイアログの標準操作）。
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  // 開いたら入力欄へフォーカスを移す（キーボード操作性・アクセシビリティ）。
  useEffect(() => {
    if (isOpen) {
      textareaRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const isCommentValid = isValidComment(comment);
  const trimmed = comment.trim();

  const handleSubmit = () => {
    // 1000 文字超過時は送信を防止する（Req 3.5）。
    if (!isCommentValid) return;
    onSubmit(trimmed.length > 0 ? trimmed : undefined);
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.4)",
        padding: "1rem",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          width: "100%",
          maxWidth: "30rem",
          padding: "1.5rem",
          borderRadius: "var(--radius, 0.5rem)",
          backgroundColor: "var(--color-surface, #ffffff)",
          boxShadow: "0 10px 25px rgba(0, 0, 0, 0.15)",
        }}
      >
        <h2
          id={titleId}
          style={{
            fontSize: "1rem",
            fontWeight: 600,
            color: "var(--color-text, #1a1a2e)",
            margin: 0,
          }}
        >
          気になった点を教えてください（任意）
        </h2>

        <p
          id={descriptionId}
          style={{
            margin: 0,
            fontSize: "0.8rem",
            color: "var(--color-text-secondary, #6b7280)",
          }}
        >
          具体的にどこが良くなかったかを記入できます。入力せずに送信することもできます。
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <label
            htmlFor={`${titleId}-textarea`}
            style={{
              fontSize: "0.8rem",
              fontWeight: 500,
              color: "var(--color-text-secondary, #374151)",
            }}
          >
            コメント
          </label>
          <textarea
            id={`${titleId}-textarea`}
            ref={textareaRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            aria-invalid={!isCommentValid ? true : undefined}
            aria-describedby={!isCommentValid ? errorId : undefined}
            style={{
              fontSize: "0.9rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "0.375rem",
              border: `1px solid ${
                isCommentValid
                  ? "var(--color-border, #d1d5db)"
                  : "#b91c1c"
              }`,
              backgroundColor: "var(--color-surface, #ffffff)",
              color: "var(--color-text, #1a1a2e)",
              resize: "vertical",
              minHeight: "5rem",
            }}
          />
          {/* 文字数カウンタ。上限超過時は警告色にする。 */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            {!isCommentValid ? (
              <span id={errorId} role="alert" style={{ fontSize: "0.75rem", color: "#b91c1c" }}>
                コメントは{FEEDBACK_COMMENT_MAX}文字以内で入力してください
              </span>
            ) : (
              <span aria-hidden="true" />
            )}
            <span
              aria-live="polite"
              style={{
                fontSize: "0.75rem",
                color: isCommentValid ? "var(--color-text-secondary, #6b7280)" : "#b91c1c",
                whiteSpace: "nowrap",
              }}
            >
              {comment.length} / {FEEDBACK_COMMENT_MAX}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: "0.85rem",
              fontWeight: 500,
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--color-border, #d1d5db)",
              backgroundColor: "var(--color-surface, #ffffff)",
              color: "var(--color-text-secondary, #374151)",
              cursor: "pointer",
            }}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isCommentValid}
            aria-disabled={!isCommentValid}
            style={{
              fontSize: "0.85rem",
              fontWeight: 600,
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "none",
              backgroundColor: isCommentValid
                ? "var(--color-primary, #0073bb)"
                : "var(--color-border, #d1d5db)",
              color: isCommentValid ? "#ffffff" : "var(--color-text-secondary, #6b7280)",
              cursor: isCommentValid ? "pointer" : "not-allowed",
            }}
          >
            送信
          </button>
        </div>
      </div>
    </div>
  );
}

export default FeedbackCommentDialog;
