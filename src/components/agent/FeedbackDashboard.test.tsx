// @vitest-environment jsdom

/**
 * FeedbackDashboard のユニットテスト（Task 7.4）
 *
 * 検証観点（代表例・エッジのみ、網羅は集計 PBT に委譲）:
 *   - トレンド描画（Req 5.5）:
 *     - 純粋ヘルパ `buildFeedbackTrendPayload` が createdAt の日付単位で
 *       Good/Bad を 2 系列の line 可視化ペイロードへ集約する
 *     - レコード 0 件では null を返す（トレンドを描画しない）
 *     - レコードありでは Dashboard がトレンドセクション（line 可視化）を描画する
 *   - 空状態表示（Req 5.7）:
 *     - レコード 0 件のときエラーではなく空状態メッセージを表示する
 *     - このとき KPI サマリー・トレンド・Bad 一覧のセクションは描画しない
 *
 * Requirements: 5.5, 5.7
 */

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { FeedbackRecordView } from "@/src/lib/agent/feedback/aggregate";
import {
  FeedbackDashboard,
  buildFeedbackTrendPayload,
} from "./FeedbackDashboard";

afterEach(() => {
  cleanup();
});

function record(
  overrides: Partial<FeedbackRecordView> = {},
): FeedbackRecordView {
  return {
    ownerUserId: "user-a",
    messageId: "msg-1",
    sentiment: "good",
    comment: null,
    createdAt: "2024-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("buildFeedbackTrendPayload（トレンド構築: Req 5.5）", () => {
  it("レコードが空のときは null を返す（トレンドを描画しない）", () => {
    expect(buildFeedbackTrendPayload([])).toBeNull();
  });

  it("createdAt の日付単位で Good/Bad を 2 系列の line ペイロードに集約する", () => {
    const records: FeedbackRecordView[] = [
      record({ sentiment: "good", createdAt: "2024-01-01T09:00:00.000Z" }),
      record({ sentiment: "good", createdAt: "2024-01-01T21:00:00.000Z" }),
      record({ sentiment: "bad", createdAt: "2024-01-01T23:00:00.000Z" }),
      record({ sentiment: "bad", createdAt: "2024-01-02T02:00:00.000Z" }),
    ];

    const payload = buildFeedbackTrendPayload(records);

    expect(payload).not.toBeNull();
    expect(payload!.type).toBe("line");
    expect(payload!.title).toBe("Good / Bad トレンド");

    // series は Good / Bad の 2 本
    const series = payload!.series as Array<{
      name: string;
      points: Array<{ x: string | number; y: number }>;
    }>;
    expect(series).toHaveLength(2);
    const good = series.find((s) => s.name === "Good")!;
    const bad = series.find((s) => s.name === "Bad")!;
    expect(good).toBeTruthy();
    expect(bad).toBeTruthy();

    // 日付キーは昇順（2024-01-01, 2024-01-02）
    expect(good.points.map((p) => p.x)).toEqual(["2024-01-01", "2024-01-02"]);
    expect(bad.points.map((p) => p.x)).toEqual(["2024-01-01", "2024-01-02"]);

    // 日毎の件数: 01-01 は good 2 / bad 1、01-02 は good 0 / bad 1
    expect(good.points.map((p) => p.y)).toEqual([2, 0]);
    expect(bad.points.map((p) => p.y)).toEqual([1, 1]);
  });

  it("不正な createdAt でも例外を投げず（全域関数）ペイロードを返す", () => {
    const payload = buildFeedbackTrendPayload([
      record({ createdAt: "not-a-date" }),
    ]);
    expect(payload).not.toBeNull();
    expect(payload!.type).toBe("line");
  });
});

describe("FeedbackDashboard の空状態表示（Req 5.7）", () => {
  it("レコード 0 件ではエラーではなく空状態メッセージを表示する", () => {
    render(<FeedbackDashboard records={[]} />);

    // 空状態の案内文が表示される
    expect(screen.getByText("まだフィードバックがありません")).toBeTruthy();

    // エラー扱いにしない（集計サマリーやトレンドは出さない）
    expect(screen.queryByLabelText("集計サマリー")).toBeNull();
    expect(screen.queryByText("Good / Bad トレンド")).toBeNull();
    expect(screen.queryByText("Bad コメント一覧")).toBeNull();
  });

  it("領域全体は常にダッシュボードの region として描画される", () => {
    render(<FeedbackDashboard records={[]} />);
    expect(
      screen.getByRole("region", { name: "フィードバック集計ダッシュボード" }),
    ).toBeTruthy();
  });
});

describe("FeedbackDashboard のトレンド描画（Req 5.5）", () => {
  it("レコードがあるときはトレンドセクション（line 可視化）を描画する", () => {
    const records: FeedbackRecordView[] = [
      record({ sentiment: "good", createdAt: "2024-01-01T09:00:00.000Z" }),
      record({
        sentiment: "bad",
        comment: "回答が的外れでした",
        createdAt: "2024-01-02T09:00:00.000Z",
      }),
    ];

    render(<FeedbackDashboard records={records} />);

    // 空状態ではない
    expect(screen.queryByText("まだフィードバックがありません")).toBeNull();

    // トレンドの見出し（セクションタイトル）が描画される
    expect(
      screen.getByRole("heading", { name: "Good / Bad トレンド" }),
    ).toBeTruthy();

    // Bad コメント一覧のセクションも描画される
    expect(
      screen.getByRole("heading", { name: "Bad コメント一覧" }),
    ).toBeTruthy();
  });
});
