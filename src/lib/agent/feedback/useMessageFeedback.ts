"use client";

import { useCallback, useRef, useState } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import {
  nextFeedbackState,
  type FeedbackSentiment,
  type FeedbackState,
} from "./feedbackState";

/**
 * useMessageFeedback — MessageFeedback 永続化フック
 *
 * 1 件のアシスタントメッセージ（Message_Id）に対する Good/Bad 評価を、
 * `generateClient<Schema>()`（既存 `RoleConfigManager` / `useChatSessions` と
 * 同じパターン）で Amplify Data Model `MessageFeedback` に永続化する。
 *
 * 永続化方針（Req 2.7, 4.5, 4.6, 4.7）:
 * - **楽観的更新 → create/update/delete → 失敗時ロールバック**:
 *   UI 状態を先に更新し、その後 Amplify の CRUD を実行する。CRUD が失敗
 *   （例外 or `errors` 返却）した場合は、直前に永続化成功していた状態へ
 *   ロールバックし、`error` にメッセージを設定する（Req 2.7）。
 * - **(owner, messageId) upsert**: 1 ユーザー × 1 Message_Id につき高々 1 レコード
 *   を維持する。既存レコードがあれば `update`、無ければ `create`、クリア
 *   （同一 sentiment 再押下）では `delete` する（Req 4.5, 4.6）。状態遷移の
 *   判定は純粋リデューサ `nextFeedbackState`（feedbackState.ts）に委譲する。
 * - **owner は identity claim に一致**: レコードの `ownerUserId` は、現在認証中の
 *   ユーザーの Cognito sub（呼び出し側から渡される `ownerUserId`）にのみ設定し、
 *   他ユーザーの identity では記録しない。未認証（`ownerUserId === null`）の場合は
 *   記録を行わずエラーを返す（Req 4.7）。サーバーサイドでも Amplify の
 *   `allow.owner()` 認可が create/update/delete を所有者に限定して強制する。
 *
 * UI ロジック（状態遷移）とインフラ（Amplify Data クライアント）を分離する
 * `amplify-frontend` ルールに従い、遷移は `nextFeedbackState` に集約し、
 * 本フックは永続化と楽観的 UI・ロールバックの副作用のみを担う。
 *
 * Requirements: 2.7, 4.5, 4.6, 4.7
 */

type MessageFeedbackRecord = Schema["MessageFeedback"]["type"];

/** フィードバックなしを表す状態（レコード不在時のデフォルト） */
const NONE_STATE: FeedbackState = { sentiment: null, comment: null };

/**
 * (messageId 単位の) 永続化済みレコードの最小ビュー。
 * ロールバックと upsert（既存レコード id の解決）に必要な情報のみ保持する。
 */
interface PersistedEntry {
  /** DynamoDB レコード id（update/delete に必要） */
  recordId: string;
  sentiment: FeedbackSentiment;
  comment: string | null;
}

export interface MutationResult {
  ok: boolean;
  error: string | null;
}

export interface UseMessageFeedbackResult {
  /** messageId → 現在の UI 表示状態（楽観的更新を反映） */
  feedbackByMessageId: Record<string, FeedbackState>;
  /** 直近の永続化エラー。成功時は null にクリアされる */
  error: string | null;
  /** 現在永続化中の messageId（UI の無効化・スピナー用）。無ければ null */
  pendingMessageId: string | null;
  /** 指定 messageId の現在状態を返す（未記録なら none） */
  getFeedback: (messageId: string) => FeedbackState;
  /**
   * Good/Bad ボタン押下時のトグル + 永続化。
   * `nextFeedbackState` に従い、記録 / 反対への更新 / 同一押下によるクリアを
   * 決定し、楽観的更新 → create/update/delete → 失敗時ロールバックを行う。
   * `comment` は結果が "bad" のときのみ採用される（それ以外では null）。
   */
  recordFeedback: (
    messageId: string,
    chatSessionId: string,
    activated: FeedbackSentiment,
    comment?: string | null,
  ) => Promise<MutationResult>;
  /**
   * 既存の "bad" フィードバックにコメントを付与・更新する（トグルしない）。
   * Feedback_Comment_Dialog からの送信で使用する。現在の sentiment が "bad"
   * でない場合は何もしない。
   */
  updateComment: (
    messageId: string,
    chatSessionId: string,
    comment: string | null,
  ) => Promise<MutationResult>;
  /** 明示的なクリア（レコード削除）。 */
  clearFeedback: (messageId: string) => Promise<MutationResult>;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function useMessageFeedback(
  ownerUserId: string | null,
): UseMessageFeedbackResult {
  // UI に表示する現在状態（楽観的更新を反映）
  const [feedbackByMessageId, setFeedbackByMessageId] = useState<
    Record<string, FeedbackState>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);

  // 最後に永続化成功した状態（messageId → レコード）。ロールバックと
  // upsert（既存 id 解決）に用いる。レンダーをまたいで安定させるため ref で保持する。
  const persistedRef = useRef<Map<string, PersistedEntry>>(new Map());

  const getFeedback = useCallback(
    (messageId: string): FeedbackState =>
      feedbackByMessageId[messageId] ?? NONE_STATE,
    [feedbackByMessageId],
  );

  /** 永続化成功済みレコードから現在の FeedbackState を導出する。 */
  const persistedState = useCallback((messageId: string): FeedbackState => {
    const entry = persistedRef.current.get(messageId);
    if (!entry) {
      return NONE_STATE;
    }
    return { sentiment: entry.sentiment, comment: entry.comment };
  }, []);

  /** 楽観的更新をロールバックし、UI を永続化済み状態へ戻す。 */
  const rollback = useCallback(
    (messageId: string) => {
      setFeedbackByMessageId((prev) => ({
        ...prev,
        [messageId]: persistedState(messageId),
      }));
    },
    [persistedState],
  );

  /**
   * 目標状態 `target` を Amplify に反映する共通処理。
   * 楽観的に UI を更新し、既存レコードの有無に応じて create/update/delete を
   * 実行する。失敗時はロールバックしてエラーを返す。
   */
  const persist = useCallback(
    async (
      messageId: string,
      chatSessionId: string,
      target: FeedbackState,
    ): Promise<MutationResult> => {
      if (!ownerUserId) {
        const message = "ユーザーが認証されていません";
        setError(message);
        return { ok: false, error: message };
      }

      // 楽観的更新
      setError(null);
      setPendingMessageId(messageId);
      setFeedbackByMessageId((prev) => ({ ...prev, [messageId]: target }));

      const existing = persistedRef.current.get(messageId);

      try {
        const client = generateClient<Schema>();

        // クリア（none）→ 既存レコードがあれば削除
        if (target.sentiment === null) {
          if (existing) {
            const { errors } = await client.models.MessageFeedback.delete({
              id: existing.recordId,
            });
            if (errors && errors.length > 0) {
              rollback(messageId);
              const message = errors.map((e) => e.message).join(", ");
              setError(message);
              return { ok: false, error: message };
            }
            persistedRef.current.delete(messageId);
          }
          return { ok: true, error: null };
        }

        const comment =
          target.sentiment === "bad" ? target.comment ?? null : null;

        // 既存レコードがあれば update（upsert の update 経路）
        if (existing) {
          const { data, errors } = await client.models.MessageFeedback.update({
            id: existing.recordId,
            sentiment: target.sentiment,
            comment,
          });
          if (errors && errors.length > 0) {
            rollback(messageId);
            const message = errors.map((e) => e.message).join(", ");
            setError(message);
            return { ok: false, error: message };
          }
          persistedRef.current.set(messageId, {
            recordId: data?.id ?? existing.recordId,
            sentiment: target.sentiment,
            comment,
          });
          return { ok: true, error: null };
        }

        // 既存レコードが無ければ create（upsert の create 経路）
        // ownerUserId は現在認証中ユーザーの Cognito sub にのみ設定する（Req 4.7）
        const { data, errors } = await client.models.MessageFeedback.create({
          ownerUserId,
          chatSessionId,
          messageId,
          sentiment: target.sentiment,
          comment,
          createdAt: new Date().toISOString(),
        });
        if (errors && errors.length > 0) {
          rollback(messageId);
          const message = errors.map((e) => e.message).join(", ");
          setError(message);
          return { ok: false, error: message };
        }
        if (data) {
          persistedRef.current.set(messageId, {
            recordId: data.id,
            sentiment: target.sentiment,
            comment,
          });
        }
        return { ok: true, error: null };
      } catch (err: unknown) {
        rollback(messageId);
        const message = errorMessage(err, "フィードバックの保存に失敗しました");
        setError(message);
        return { ok: false, error: message };
      } finally {
        setPendingMessageId((current) =>
          current === messageId ? null : current,
        );
      }
    },
    [ownerUserId, rollback],
  );

  const recordFeedback = useCallback(
    (
      messageId: string,
      chatSessionId: string,
      activated: FeedbackSentiment,
      comment?: string | null,
    ): Promise<MutationResult> => {
      const current = getFeedback(messageId);
      const next = nextFeedbackState(current, activated);
      // 結果が "bad" のときのみ、呼び出し側が渡した comment を採用する
      const target: FeedbackState =
        next.sentiment === "bad" && comment !== undefined
          ? { sentiment: "bad", comment: comment ?? null }
          : next;
      return persist(messageId, chatSessionId, target);
    },
    [getFeedback, persist],
  );

  const updateComment = useCallback(
    (
      messageId: string,
      chatSessionId: string,
      comment: string | null,
    ): Promise<MutationResult> => {
      const current = getFeedback(messageId);
      // "bad" フィードバックにのみコメントを付与する（トグルしない）
      if (current.sentiment !== "bad") {
        return Promise.resolve({ ok: true, error: null });
      }
      return persist(messageId, chatSessionId, {
        sentiment: "bad",
        comment: comment && comment.length > 0 ? comment : null,
      });
    },
    [getFeedback, persist],
  );

  const clearFeedback = useCallback(
    (messageId: string): Promise<MutationResult> => {
      const existing = persistedRef.current.get(messageId);
      // chatSessionId は削除経路では未使用のため空文字でよい
      return persist(messageId, existing ? "" : "", NONE_STATE);
    },
    [persist],
  );

  return {
    feedbackByMessageId,
    error,
    pendingMessageId,
    getFeedback,
    recordFeedback,
    updateComment,
    clearFeedback,
  };
}

export default useMessageFeedback;
