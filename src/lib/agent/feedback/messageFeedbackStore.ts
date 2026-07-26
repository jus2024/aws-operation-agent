/**
 * (owner, messageId) 単位の Feedback ローカルストアロジック（純粋関数モジュール）
 *
 * `feedbackState.ts` / `aggregate.ts` / `accessGates.ts` と同じ
 * 「UI ロジックを純粋関数に切り出す」パターンを踏襲する。
 * React hooks や API コール（Amplify Data クライアント）に依存しない。
 *
 * `useMessageFeedback` フック（Task 6.1）が Amplify Data 経由で行う
 * create / update / delete の upsert 方針を、インフラ非依存の純粋ロジックとして
 * 表現する。1 つの (ownerUserId, messageId) の組に対し高々 1 レコードを維持し、
 * クリア操作では対応レコードを削除する（0 件にする）。
 *
 * `nextFeedbackState`（feedbackState.ts）を状態遷移の唯一のソースとして再利用する。
 *
 * Requirements: 4.5, 4.6
 */

import {
  nextFeedbackState,
  type FeedbackSentiment,
  type FeedbackState,
} from "./feedbackState";

/**
 * ローカルストアに保持される 1 件の Feedback レコード。
 * (ownerUserId, messageId) の組で一意。
 */
export interface MessageFeedbackRecord {
  /** レコード所有者（Cognito sub） */
  ownerUserId: string;
  /** 紐づくアシスタントメッセージの Message_Id */
  messageId: string;
  /** 評価値（"good" | "bad"） */
  sentiment: FeedbackSentiment;
  /** bad のときのみ意味を持つ任意コメント。無い場合は null */
  comment: string | null;
}

/**
 * ユーザーがある (ownerUserId, messageId) に対して起こす操作。
 *
 * - `kind: "toggle"` — Good/Bad ボタン押下。`nextFeedbackState` に委譲して
 *   記録 / 反対への更新 / 同一押下によるクリアを決定する。任意で `comment`
 *   を伴う（bad を記録・維持する場合のみ意味を持つ）。
 * - `kind: "clear"` — 明示的なクリア（レコード削除）。
 */
export type FeedbackAction =
  | {
      kind: "toggle";
      ownerUserId: string;
      messageId: string;
      activated: FeedbackSentiment;
      comment?: string | null;
    }
  | {
      kind: "clear";
      ownerUserId: string;
      messageId: string;
    };

/**
 * (ownerUserId, messageId) をキーにした Feedback レコードのストア。
 * キーは `storeKey(ownerUserId, messageId)` で生成する。
 */
export type MessageFeedbackStore = ReadonlyMap<string, MessageFeedbackRecord>;

/** 空のストアを生成する。 */
export function createStore(): MessageFeedbackStore {
  return new Map<string, MessageFeedbackRecord>();
}

/**
 * (ownerUserId, messageId) の組を一意なストアキーへ写像する。
 * 区切り文字にはフィールド値に現れない制御文字（U+0000）を用い、
 * 値の境界が曖昧にならないようにする。
 */
export function storeKey(ownerUserId: string, messageId: string): string {
  return `${ownerUserId}\u0000${messageId}`;
}

/**
 * ストア内のレコードを現在の `FeedbackState` へ写像する。
 * レコードが無ければ「フィードバックなし」を表す状態を返す。
 */
function currentState(record: MessageFeedbackRecord | undefined): FeedbackState {
  if (record === undefined) {
    return { sentiment: null, comment: null };
  }
  return { sentiment: record.sentiment, comment: record.comment };
}

/**
 * 単一のアクションをストアに適用し、新しいストアを返す（入力は変更しない）。
 *
 * upsert 方針:
 *   - `toggle` の結果が sentiment を持つ  → レコードを create/update（高々 1 件を維持）
 *   - `toggle` の結果が null（同一押下）   → レコードを delete（0 件）
 *   - `clear`                            → レコードを delete（0 件）
 *
 * "bad" を記録・更新する場合は、アクションに付与された `comment` を採用する
 * （未指定・null の場合は null）。それ以外の sentiment では comment は常に null。
 *
 * Requirements: 4.5, 4.6
 */
export function applyAction(
  store: MessageFeedbackStore,
  action: FeedbackAction,
): MessageFeedbackStore {
  const key = storeKey(action.ownerUserId, action.messageId);
  const next = new Map(store);

  if (action.kind === "clear") {
    next.delete(key);
    return next;
  }

  const resultState = nextFeedbackState(currentState(store.get(key)), action.activated);

  if (resultState.sentiment === null) {
    // 同一 sentiment の再押下 → クリア（0 件）
    next.delete(key);
    return next;
  }

  const comment =
    resultState.sentiment === "bad" ? action.comment ?? null : null;

  next.set(key, {
    ownerUserId: action.ownerUserId,
    messageId: action.messageId,
    sentiment: resultState.sentiment,
    comment,
  });
  return next;
}

/**
 * アクション列を順に適用し、最終的なストアを返す。
 *
 * 任意の good/bad/clear のアクション列に対して、各 (ownerUserId, messageId) の
 * 組には高々 1 レコードしか存在せず、直近のアクションがその組をクリアする
 * ものであれば 0 件になる（Requirements 4.5, 4.6）。
 */
export function applyActions(
  store: MessageFeedbackStore,
  actions: readonly FeedbackAction[],
): MessageFeedbackStore {
  return actions.reduce<MessageFeedbackStore>(applyAction, store);
}

/**
 * (ownerUserId, messageId) に対応するレコードを取得する。無ければ undefined。
 */
export function getRecord(
  store: MessageFeedbackStore,
  ownerUserId: string,
  messageId: string,
): MessageFeedbackRecord | undefined {
  return store.get(storeKey(ownerUserId, messageId));
}
