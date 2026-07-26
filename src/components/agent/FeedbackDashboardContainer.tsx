"use client";

import { useFeedbackRecords } from "@/src/lib/agent/feedback/useFeedbackRecords";
import { FeedbackDashboard } from "./FeedbackDashboard";

/**
 * FeedbackDashboardContainer — 読み取り層と表示層をつなぐコンテナ
 *
 * `useFeedbackRecords` で `MessageFeedback` を全オーナー横断で読み取り
 * （all-authenticated read: Req 5.2, 5.8）、その状態に応じて描画を切り替える。
 *
 * 状態の区別（Req 5.7, 5.8）:
 * - **loading**: 読み取り中インジケーターを表示する。
 * - **error**: エラーインジケーターと **再試行導線**（reload ボタン）を表示する。
 *   空状態とは明確に区別し、この場合は集計・空状態を描画しない。
 * - **ready**: 読み取り成功。`records` を `FeedbackDashboard` に渡す。0 件の
 *   場合は `FeedbackDashboard` 側が空状態（エラーではない）を描画する（Req 5.7）。
 *
 * 表示専用の `FeedbackDashboard`（`records` を props で受ける純粋な
 * プレゼンテーション）を、読み取り・エラー/空状態の制御から分離したまま利用する
 * （`amplify-frontend` ルール: UI ロジックとインフラを分離）。
 *
 * page.tsx への配線（導線・オーバーレイ）は後続タスク 7.3 の責務。
 *
 * Requirements: 5.7, 5.8
 */

export interface FeedbackDashboardContainerProps {
  /** ダッシュボードを閉じる導線（`FeedbackDashboard` / エラー画面に伝播） */
  onClose?: () => void;
}

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.25rem",
  maxWidth: "70rem",
};

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--color-border, #dce1ea)",
  borderRadius: "0.75rem",
  backgroundColor: "var(--color-surface, #ffffff)",
  padding: "1.25rem",
};

function CloseButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="閉じる"
      style={{
        fontSize: "0.8rem",
        fontWeight: 500,
        padding: "0.375rem 0.75rem",
        borderRadius: "0.375rem",
        border: "1px solid var(--color-border, #d1d5db)",
        backgroundColor: "var(--color-surface, #ffffff)",
        color: "var(--color-text-secondary, #374151)",
        cursor: "pointer",
      }}
    >
      閉じる
    </button>
  );
}

export function FeedbackDashboardContainer({
  onClose,
}: FeedbackDashboardContainerProps) {
  const { records, status, error, reload } = useFeedbackRecords();

  if (status === "loading") {
    return (
      <div
        role="region"
        aria-label="フィードバック集計ダッシュボード"
        style={panelStyle}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <h2
            style={{
              fontSize: "1.35rem",
              fontWeight: 700,
              margin: 0,
              color: "var(--color-text, #17203a)",
            }}
          >
            フィードバック集計ダッシュボード
          </h2>
          <CloseButton onClose={onClose} />
        </div>
        <div
          role="status"
          style={{
            ...cardStyle,
            textAlign: "center",
            padding: "2rem 1rem",
            color: "var(--color-text-secondary, #4a5568)",
            fontSize: "0.9rem",
          }}
        >
          フィードバックを読み込んでいます...
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        role="region"
        aria-label="フィードバック集計ダッシュボード"
        style={panelStyle}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <h2
            style={{
              fontSize: "1.35rem",
              fontWeight: 700,
              margin: 0,
              color: "var(--color-text, #17203a)",
            }}
          >
            フィードバック集計ダッシュボード
          </h2>
          <CloseButton onClose={onClose} />
        </div>
        <div
          role="alert"
          style={{
            ...cardStyle,
            borderColor: "var(--color-bad, #c0392b)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1rem",
            textAlign: "center",
            padding: "2rem 1rem",
          }}
        >
          <div>
            <p
              style={{
                fontSize: "1.05rem",
                fontWeight: 600,
                color: "var(--color-bad, #c0392b)",
                margin: "0 0 0.5rem",
              }}
            >
              フィードバックの読み取りに失敗しました
            </p>
            <p
              style={{
                fontSize: "0.9rem",
                color: "var(--color-text-secondary, #4a5568)",
                margin: 0,
                maxWidth: "36rem",
                wordBreak: "break-word",
              }}
            >
              {error ?? "不明なエラーが発生しました。"}
            </p>
          </div>
          <button
            type="button"
            onClick={reload}
            style={{
              fontSize: "0.85rem",
              fontWeight: 600,
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--color-primary, #0073bb)",
              backgroundColor: "var(--color-primary, #0073bb)",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            再試行
          </button>
        </div>
      </div>
    );
  }

  // status === "ready": 0 件のときは FeedbackDashboard が空状態を描画する（Req 5.7）
  return <FeedbackDashboard records={records} onClose={onClose} />;
}

export default FeedbackDashboardContainer;
