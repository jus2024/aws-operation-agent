/**
 * Good/Bad フィードバックのトグル状態遷移とコメント長バリデーション
 * （純粋関数モジュール）
 *
 * `accessGates.ts` / `roleConfigValidation.ts` と同じ
 * 「UI ロジックを純粋関数に切り出す」パターンを踏襲する。
 * React hooks や API コール（Amplify Data クライアント）に依存しない。
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5, 3.5, 3.6
 */

export type FeedbackSentiment = "good" | "bad";

export interface FeedbackState {
  /** null = フィードバックなし */
  sentiment: FeedbackSentiment | null;
  /** bad のときのみ意味を持つ。sentiment !== "bad" のときは常に null */
  comment: string | null;
}

/**
 * Feedback トグルの純粋リデューサ。
 *
 * 現在の状態 `current` に対してユーザーが `activated`（good/bad）を押下した
 * ときの次状態を返す。
 *
 * 遷移:
 *   - `current.sentiment === null`（フィードバックなし） → `activated` を記録
 *   - `current.sentiment` が `activated` と反対          → `activated` に更新
 *       （bad → good の場合、それまでの comment は破棄され null になる: Req 3.6）
 *   - `current.sentiment === activated`（同一押下）       → クリア（null）: Req 2.5
 *
 * 結果の `sentiment` が "bad" でない場合、結果の `comment` は常に null。
 * "bad" を新規に記録する場合も comment は null から始まり、コメント本文は
 * 後続の Feedback_Comment_Dialog が別途付与する。
 *
 * `current` は変更せず、常に新しい `FeedbackState` を返す。
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5, 3.6
 */
export function nextFeedbackState(
  current: FeedbackState,
  activated: FeedbackSentiment,
): FeedbackState {
  // 同一 sentiment の再押下 → クリア
  if (current.sentiment === activated) {
    return { sentiment: null, comment: null };
  }

  // none + activated、または反対 sentiment からの更新 → activated を記録
  // いずれの場合も comment はリセットする（bad→good の comment 破棄を含む）
  return { sentiment: activated, comment: null };
}

/** Feedback_Comment の最大文字数（Req 3.5） */
export const FEEDBACK_COMMENT_MAX = 1000;

/**
 * Feedback_Comment の長さバリデーション。
 * 長さが `FEEDBACK_COMMENT_MAX`（1000）以下のとき true を返す。
 * 境界 1000 は有効、1001 は無効。
 *
 * Requirements: 3.5
 */
export function isValidComment(comment: string): boolean {
  return comment.length <= FEEDBACK_COMMENT_MAX;
}
