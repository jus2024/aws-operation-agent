"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import type { FeedbackRecordView } from "./aggregate";

/**
 * useFeedbackRecords — Feedback_Dashboard 用の MessageFeedback 読み取りフック
 *
 * `generateClient<Schema>()`（既存 `RoleConfigManager` / `useMessageFeedback` と
 * 同じパターン）で `MessageFeedback` モデルを **全オーナー横断** で読み取り、
 * `FeedbackDashboard` が受け取る `FeedbackRecordView[]` へ写像する。
 *
 * 読み取りは Amplify Data の `allow.authenticated().to(["read"])` 認可
 * （Req 4.3）に依拠する。これにより、認証済みの任意ユーザーが自分以外の
 * ユーザーが投稿した Feedback（Bad の自由記述コメントを含む）まで読み取れる
 * （Req 5.2, 5.8）。owner フィルタは掛けず、`list()` が返す全レコードを
 * 集計対象とする。
 *
 * 状態の区別（Req 5.7, 5.8）:
 * - **loading**: 読み取り中。空状態・エラーとは区別する。
 * - **error**: 読み取り失敗（ネットワーク/権限/例外/`errors` 返却）。エラー
 *   インジケーターと再試行導線（`reload`）を提示するために `status === "error"`
 *   を返す。空状態とは明確に区別し、集計は行わない（`records` は空配列）。
 * - **ready**: 読み取り成功。`records.length === 0` のときは「Feedback 0 件」の
 *   空状態であり、エラーではない（`FeedbackDashboard` 側が空状態を描画する）。
 *
 * UI ロジック（状態の区別）とインフラ（Amplify Data クライアント）を分離する
 * `amplify-frontend` ルールに従い、本フックは読み取りと状態管理のみを担い、
 * 集計（`aggregateFeedback`）や描画は呼び出し側（`FeedbackDashboard`）に委ねる。
 * レコード → ビューの写像は純粋関数 `mapToFeedbackRecordView` に切り出す。
 *
 * Requirements: 5.7, 5.8
 */

type MessageFeedbackRecord = Schema["MessageFeedback"]["type"];

/** 読み取りの状態。空状態とエラーを明確に区別する（Req 5.7, 5.8） */
export type FeedbackRecordsStatus = "loading" | "error" | "ready";

export interface UseFeedbackRecordsResult {
  /** 全オーナー横断で読み取り済みの Feedback レコード（error 時は空配列） */
  records: FeedbackRecordView[];
  /** 現在の読み取り状態（loading / error / ready） */
  status: FeedbackRecordsStatus;
  /** 読み取りエラーメッセージ。error 状態以外では null */
  error: string | null;
  /** status === "loading" の糖衣 */
  isLoading: boolean;
  /** 読み取り成功かつ 0 件（空状態）。error とは区別される（Req 5.7） */
  isEmpty: boolean;
  /** 再読み取り（エラー時の再試行導線: Req 5.8） */
  reload: () => void;
}

/**
 * `MessageFeedback` レコードを集計用の `FeedbackRecordView` へ写像する純粋関数。
 *
 * `sentiment` は Amplify スキーマ上 enum（`"good" | "bad" | null`）であり、
 * null（不正/未設定）のレコードは集計対象外として `null` を返す。呼び出し側は
 * `null` を除外する。`comment` は未設定時 `null` に正規化する。
 */
export function mapToFeedbackRecordView(
  record: MessageFeedbackRecord,
): FeedbackRecordView | null {
  if (record.sentiment !== "good" && record.sentiment !== "bad") {
    return null;
  }
  return {
    ownerUserId: record.ownerUserId,
    messageId: record.messageId,
    sentiment: record.sentiment,
    comment: record.comment ?? null,
    createdAt: record.createdAt,
  };
}

export function useFeedbackRecords(): UseFeedbackRecordsResult {
  const [records, setRecords] = useState<FeedbackRecordView[]>([]);
  const [status, setStatus] = useState<FeedbackRecordsStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // アンマウント後の setState を避けるためのマウント状態フラグ
  const mountedRef = useRef(true);

  const fetchRecords = useCallback(async () => {
    setStatus("loading");
    setError(null);

    try {
      const client = generateClient<Schema>();

      // 全オーナー横断の読み取り（owner フィルタなし）。list() はページングされる
      // ため、nextToken を辿って全ページを取得してから集計対象に渡す。
      const collected: MessageFeedbackRecord[] = [];
      let nextToken: string | null | undefined = undefined;

      do {
        const page: {
          data: MessageFeedbackRecord[];
          nextToken?: string | null;
          errors?: ReadonlyArray<{ message: string }>;
        } = await client.models.MessageFeedback.list({ nextToken });

        if (page.errors && page.errors.length > 0) {
          if (mountedRef.current) {
            setError(page.errors.map((e) => e.message).join(", "));
            setRecords([]);
            setStatus("error");
          }
          return;
        }

        if (page.data) {
          collected.push(...page.data);
        }
        nextToken = page.nextToken;
      } while (nextToken);

      const views = collected
        .map(mapToFeedbackRecordView)
        .filter((v): v is FeedbackRecordView => v !== null);

      if (mountedRef.current) {
        setRecords(views);
        setStatus("ready");
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "フィードバックの読み取りに失敗しました";
      if (mountedRef.current) {
        setError(message);
        setRecords([]);
        setStatus("error");
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchRecords();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchRecords]);

  const reload = useCallback(() => {
    fetchRecords();
  }, [fetchRecords]);

  return {
    records,
    status,
    error,
    isLoading: status === "loading",
    isEmpty: status === "ready" && records.length === 0,
    reload,
  };
}

export default useFeedbackRecords;
