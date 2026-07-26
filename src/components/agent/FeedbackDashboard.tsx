"use client";

import {
  aggregateFeedback,
  type FeedbackAggregate,
  type FeedbackRecordView,
} from "@/src/lib/agent/feedback/aggregate";
import type { VisualizationPayload } from "@/src/lib/agent/visualization/schema";
import { Visualization } from "./visualization/Visualization";

/**
 * FeedbackDashboard — 全ユーザー横断の Feedback 集計ダッシュボード（表示専用）
 *
 * 認証済みの全ユーザーが閲覧できる集計画面（Requirement 5）。本コンポーネントは
 * 「表示」に専念する純粋なプレゼンテーションであり、Amplify Data からの読み取りや
 * エラー/再試行の制御は行わない（それらは後続タスク 7.2、page.tsx への配線は 7.3）。
 * 集計対象の `records`（全オーナー横断で読み取り済みの Feedback）を props で受け取り、
 * `aggregateFeedback` の純粋ロジックで集計してから描画する。
 *
 * 表示内容:
 *   - Good/Bad 件数と Good 比率（Requirement 5.2, 5.4）
 *   - Good/Bad の時系列トレンド（Task 5 の `Visualization` を line 型で再利用: Req 5.5）
 *   - Bad 評価 + コメント一覧（他ユーザー投稿を含む: Req 5.6）
 *   - Feedback が 0 件のときはエラーではなく空状態（Req 5.7）
 *
 * 純粋ロジック（`aggregateFeedback` / `buildFeedbackTrendPayload`）を UI から分離し、
 * トレンド用のペイロード生成も例外を投げない全域関数として実装する
 * （`amplify-frontend` ルール: UI ロジックとインフラを分離）。
 *
 * Requirements: 5.2, 5.4, 5.5, 5.6, 5.7
 */

export interface FeedbackDashboardProps {
  /** 全オーナー横断で読み取り済みの Feedback レコード（読み取りは 7.2 の責務） */
  records: FeedbackRecordView[];
  /** ダッシュボードを閉じる導線（省略時は閉じるボタンを表示しない） */
  onClose?: () => void;
}

/** ISO 文字列から日付部分（YYYY-MM-DD）を安全に取り出す（不正日時は原文を返す）。 */
function toDayKey(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return iso;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Feedback レコード集合から Good/Bad の時系列トレンドを表す line 可視化
 * ペイロードを構築する純粋関数（例外を投げない全域関数）。
 *
 * createdAt の日付単位（YYYY-MM-DD）でグルーピングし、日毎の Good/Bad 件数を
 * 2 系列（Good / Bad）の折れ線として返す。レコードが空の場合は null を返し、
 * 呼び出し側はトレンドを描画しない（空状態で処理される）。
 *
 * Requirements: 5.5
 */
export function buildFeedbackTrendPayload(
  records: FeedbackRecordView[],
): VisualizationPayload | null {
  if (records.length === 0) {
    return null;
  }

  const byDay = new Map<string, { good: number; bad: number }>();
  for (const record of records) {
    const day = toDayKey(record.createdAt);
    const bucket = byDay.get(day) ?? { good: 0, bad: 0 };
    if (record.sentiment === "good") {
      bucket.good += 1;
    } else if (record.sentiment === "bad") {
      bucket.bad += 1;
    }
    byDay.set(day, bucket);
  }

  const days = Array.from(byDay.keys()).sort();

  return {
    type: "line",
    title: "Good / Bad トレンド",
    series: [
      {
        name: "Good",
        points: days.map((d) => ({ x: d, y: byDay.get(d)!.good })),
      },
      {
        name: "Bad",
        points: days.map((d) => ({ x: d, y: byDay.get(d)!.bad })),
      },
    ],
  };
}

/** Good 比率をパーセント表記（整数）へ整形する。 */
function formatRatioPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--color-border, #dce1ea)",
  borderRadius: "0.75rem",
  backgroundColor: "var(--color-surface, #ffffff)",
  padding: "1.25rem",
  boxShadow: "var(--shadow-sm, 0 1px 2px rgba(16, 24, 40, 0.06))",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 600,
  margin: 0,
  color: "var(--color-text, #17203a)",
};

function KpiCard({
  label,
  value,
  meta,
  valueColor,
  dotColor,
}: {
  label: string;
  value: string;
  meta?: string;
  valueColor?: string;
  dotColor?: string;
}) {
  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "var(--color-text-secondary, #4a5568)",
        }}
      >
        {dotColor && (
          <span
            aria-hidden="true"
            style={{
              width: "0.7rem",
              height: "0.7rem",
              borderRadius: "50%",
              backgroundColor: dotColor,
              display: "inline-block",
            }}
          />
        )}
        {label}
      </div>
      <div
        style={{
          fontSize: "2.2rem",
          fontWeight: 700,
          lineHeight: 1.1,
          marginTop: "0.75rem",
          fontVariantNumeric: "tabular-nums",
          color: valueColor ?? "var(--color-text, #17203a)",
        }}
      >
        {value}
      </div>
      {meta && (
        <div
          style={{
            fontSize: "0.8rem",
            color: "var(--color-text-muted, #6b7280)",
            marginTop: "0.5rem",
          }}
        >
          {meta}
        </div>
      )}
    </div>
  );
}

export function FeedbackDashboard({ records, onClose }: FeedbackDashboardProps) {
  const aggregate: FeedbackAggregate = aggregateFeedback(records);
  const isEmpty = aggregate.total === 0;
  const trendPayload = buildFeedbackTrendPayload(records);

  return (
    <div
      role="region"
      aria-label="フィードバック集計ダッシュボード"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
        padding: "1.25rem",
        maxWidth: "70rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
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
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.9rem",
              color: "var(--color-text-secondary, #4a5568)",
            }}
          >
            アシスタント回答への Good / Bad 評価を、全ユーザーを横断して集計します。
          </p>
        </div>
        {onClose && (
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
        )}
      </div>

      {isEmpty ? (
        <div style={cardStyle}>
          <div
            style={{
              textAlign: "center",
              padding: "2rem 1rem",
              color: "var(--color-text-secondary, #4a5568)",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                fontSize: "2.4rem",
                display: "block",
                marginBottom: "0.75rem",
                opacity: 0.7,
              }}
            >
              💬
            </span>
            <p
              style={{
                fontSize: "1.05rem",
                fontWeight: 600,
                color: "var(--color-text, #17203a)",
                margin: "0 0 0.5rem",
              }}
            >
              まだフィードバックがありません
            </p>
            <p
              style={{
                fontSize: "0.9rem",
                maxWidth: "32rem",
                margin: "0 auto",
              }}
            >
              アシスタントの回答に Good / Bad が付くと、ここに件数・比率・トレンド・Bad
              コメントが集計表示されます。
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* KPI サマリー（Req 5.2, 5.4） */}
          <section
            aria-label="集計サマリー"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "1rem",
            }}
          >
            <KpiCard
              label="Good 件数"
              value={aggregate.goodCount.toLocaleString()}
              dotColor="var(--color-good, #1f8f57)"
              valueColor="var(--color-good, #1f8f57)"
            />
            <KpiCard
              label="Bad 件数"
              value={aggregate.badCount.toLocaleString()}
              dotColor="var(--color-bad, #c0392b)"
              valueColor="var(--color-bad, #c0392b)"
            />
            <KpiCard
              label="総評価数"
              value={aggregate.total.toLocaleString()}
              dotColor="var(--color-primary, #0073bb)"
              meta={`うちコメント付き Bad ${aggregate.badWithComments.filter((r) => (r.comment ?? "").trim().length > 0).length} 件`}
            />
            <KpiCard
              label="Good 比率"
              value={formatRatioPercent(aggregate.goodRatio)}
              meta={`Good ÷ 総評価数 = ${aggregate.goodCount.toLocaleString()} / ${aggregate.total.toLocaleString()}`}
              valueColor="var(--color-good, #1f8f57)"
            />
          </section>

          {/* Good/Bad トレンド（Task 5 の Visualization を line 型で再利用: Req 5.5） */}
          <section style={cardStyle} aria-labelledby="feedback-trend-title">
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "0.75rem",
                marginBottom: "0.5rem",
              }}
            >
              <h3 id="feedback-trend-title" style={sectionTitleStyle}>
                Good / Bad トレンド
              </h3>
              <span
                style={{
                  fontSize: "0.8rem",
                  color: "var(--color-text-muted, #6b7280)",
                }}
              >
                日次・全ユーザー
              </span>
            </div>
            {trendPayload && <Visualization payload={trendPayload} />}
          </section>

          {/* Bad コメント一覧（Req 5.6） */}
          <section style={cardStyle} aria-labelledby="feedback-bad-title">
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "0.75rem",
                marginBottom: "0.75rem",
              }}
            >
              <h3 id="feedback-bad-title" style={sectionTitleStyle}>
                Bad コメント一覧
              </h3>
              <span
                style={{
                  fontSize: "0.8rem",
                  color: "var(--color-text-muted, #6b7280)",
                }}
              >
                全ユーザーの投稿（{aggregate.badWithComments.length} 件）
              </span>
            </div>

            {aggregate.badWithComments.length === 0 ? (
              <p
                style={{
                  fontSize: "0.9rem",
                  color: "var(--color-text-secondary, #4a5568)",
                  margin: 0,
                }}
              >
                Bad 評価はまだありません。
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                  maxHeight: "26rem",
                  overflowY: "auto",
                }}
              >
                {aggregate.badWithComments.map((record, i) => {
                  const hasComment = (record.comment ?? "").trim().length > 0;
                  return (
                    <li
                      key={`${record.ownerUserId}-${record.messageId}-${i}`}
                      style={{
                        border: "1px solid var(--color-border, #dce1ea)",
                        borderLeft: "4px solid var(--color-bad, #c0392b)",
                        borderRadius: "0.5rem",
                        backgroundColor: "var(--color-surface-alt, #f8fafc)",
                        padding: "0.75rem 1rem",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "0.5rem",
                          marginBottom: "0.5rem",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "var(--color-bad, #c0392b)",
                            backgroundColor: "var(--color-bad-soft, #fbeae7)",
                            padding: "0.125rem 0.5rem",
                            borderRadius: "9999px",
                          }}
                        >
                          BAD
                        </span>
                        <time
                          style={{
                            fontSize: "0.76rem",
                            color: "var(--color-text-muted, #6b7280)",
                          }}
                          dateTime={record.createdAt}
                        >
                          {toDayKey(record.createdAt)}
                        </time>
                      </div>
                      <p
                        style={{
                          fontSize: "0.9rem",
                          color: hasComment
                            ? "var(--color-text, #17203a)"
                            : "var(--color-text-muted, #6b7280)",
                          margin: 0,
                          fontStyle: hasComment ? "normal" : "italic",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {hasComment ? record.comment : "（コメントなし）"}
                      </p>
                      <p
                        style={{
                          fontSize: "0.76rem",
                          color: "var(--color-text-muted, #6b7280)",
                          marginTop: "0.5rem",
                          marginBottom: 0,
                          fontFamily:
                            "var(--font-mono, ui-monospace, monospace)",
                          wordBreak: "break-all",
                        }}
                      >
                        session: {record.messageId}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default FeedbackDashboard;
