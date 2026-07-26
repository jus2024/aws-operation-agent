/**
 * 全ユーザー横断の Feedback 集計ロジック（純粋関数モジュール）
 *
 * `feedbackState.ts` / `accessGates.ts` と同じ
 * 「UI ロジックを純粋関数に切り出す」パターンを踏襲する。
 * React hooks や API コール（Amplify Data クライアント）に依存しない。
 *
 * Feedback_Dashboard が表示する集計値（Good/Bad 件数・Good 比率・
 * Bad コメント一覧）を、閲覧者に依存せず入力集合全体から算出する。
 *
 * Requirements: 5.2, 5.4, 5.6, 5.7
 */

import type { FeedbackSentiment } from "./feedbackState";

/**
 * 集計対象となる 1 件の Feedback レコードのビュー表現。
 * Amplify Data の `MessageFeedback` から読み取ったレコードを、
 * 集計に必要なフィールドへ写像したもの（複数オーナー混在を含む）。
 */
export interface FeedbackRecordView {
  /** レコード所有者（Cognito sub）。集計は閲覧者ではなく全オーナー横断で行う */
  ownerUserId: string;
  /** 紐づくアシスタントメッセージの Message_Id */
  messageId: string;
  /** 評価値（"good" | "bad"） */
  sentiment: FeedbackSentiment;
  /** bad のときのみ意味を持つ任意コメント。無い場合は null */
  comment: string | null;
  /** 作成タイムスタンプ（ISO 文字列） */
  createdAt: string;
}

/**
 * 全ユーザー横断の集計結果。
 */
export interface FeedbackAggregate {
  /** "good" 評価の件数 */
  goodCount: number;
  /** "bad" 評価の件数 */
  badCount: number;
  /** 全 Feedback レコード件数（= goodCount + badCount = |records|） */
  total: number;
  /** "good" の比率。total === 0 のときは 0 */
  goodRatio: number;
  /** sentiment === "bad" のレコードのみ（Bad コメント一覧用） */
  badWithComments: FeedbackRecordView[];
}

/**
 * 全ユーザー横断で Feedback レコード集合を集計する。
 *
 * 不変条件:
 *   - `goodCount + badCount === total`
 *   - `total === records.length`（閲覧者に依存せず入力集合全体を反映）
 *   - `total > 0` のとき `goodRatio === goodCount / total`
 *   - `total === 0`（空集合）のとき `goodRatio === 0` かつ全カウント 0（エラーにしない）
 *   - `badWithComments` の全要素は `sentiment === "bad"`
 *
 * 入力配列は変更しない。
 *
 * Requirements: 5.2, 5.4, 5.6, 5.7
 */
export function aggregateFeedback(
  records: FeedbackRecordView[],
): FeedbackAggregate {
  let goodCount = 0;
  let badCount = 0;
  const badWithComments: FeedbackRecordView[] = [];

  for (const record of records) {
    if (record.sentiment === "good") {
      goodCount += 1;
    } else if (record.sentiment === "bad") {
      badCount += 1;
      badWithComments.push(record);
    }
  }

  const total = goodCount + badCount;
  const goodRatio = total === 0 ? 0 : goodCount / total;

  return {
    goodCount,
    badCount,
    total,
    goodRatio,
    badWithComments,
  };
}
