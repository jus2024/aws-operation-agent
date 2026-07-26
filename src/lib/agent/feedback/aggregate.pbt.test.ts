/**
 * Property-based tests for aggregateFeedback (全ユーザー横断の集計不変条件)
 *
 * **Validates: Requirements 5.2, 5.4, 5.6, 5.7**
 *
 * Property 7: 全ユーザー横断の集計不変条件
 * - goodCount + badCount === total
 * - total === records.length（閲覧者に依存せず入力集合全体を反映）
 * - total > 0 のとき goodRatio === goodCount / total
 * - total === 0（空集合）のとき goodRatio === 0 かつ全カウント 0（エラーにならない）
 * - badWithComments の全要素は sentiment === "bad"
 *   （かつ入力中の bad レコードと過不足なく一致する）
 *
 * Tag: Feature: ui-ux-enhancements, Property 7: 全ユーザー横断の集計不変条件
 */

import fc from "fast-check";
import { aggregateFeedback, FeedbackRecordView } from "./aggregate";
import { FeedbackSentiment } from "./feedbackState";

// --- Generators ---

/** 評価値: good または bad */
const sentiment: fc.Arbitrary<FeedbackSentiment> = fc.constantFrom(
  "good",
  "bad"
);

/** 任意の comment（null / 空文字 / 任意文字列、Unicode 含む） */
const anyComment: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.string({ maxLength: 200 })
);

/**
 * 複数オーナーが混在するように、少数の owner id 空間から選ぶ。
 * これにより「集計は閲覧者ではなく全オーナー横断で行われる」ことを
 * 意味のある形で検証できる（同一集合内に複数の distinct owner を含めやすくする）。
 */
const ownerUserId: fc.Arbitrary<string> = fc.constantFrom(
  "user-a",
  "user-b",
  "user-c",
  "user-d"
);

/** ISO 文字列の createdAt（範囲は限定するが値そのものは集計に影響しない） */
const createdAt: fc.Arbitrary<string> = fc
  .date({
    min: new Date("2020-01-01T00:00:00.000Z"),
    max: new Date("2030-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/** 1 件の Feedback レコード（複数オーナー混在） */
const feedbackRecord: fc.Arbitrary<FeedbackRecordView> = fc.record({
  ownerUserId,
  messageId: fc.string({ minLength: 1, maxLength: 40 }),
  sentiment,
  comment: anyComment,
  createdAt,
});

/** レコード集合（空集合を含む、複数オーナー混在） */
const recordSet: fc.Arbitrary<FeedbackRecordView[]> = fc.array(
  feedbackRecord,
  { maxLength: 200 }
);

// --- Properties ---

describe("Property 7: 全ユーザー横断の集計不変条件", () => {
  it("goodCount + badCount === total かつ total === records.length", () => {
    fc.assert(
      fc.property(recordSet, (records) => {
        const agg = aggregateFeedback(records);
        expect(agg.goodCount + agg.badCount).toBe(agg.total);
        expect(agg.total).toBe(records.length);
      }),
      { numRuns: 100 }
    );
  });

  it("goodCount / badCount は入力中の該当 sentiment 件数と一致する", () => {
    fc.assert(
      fc.property(recordSet, (records) => {
        const expectedGood = records.filter(
          (r) => r.sentiment === "good"
        ).length;
        const expectedBad = records.filter(
          (r) => r.sentiment === "bad"
        ).length;
        const agg = aggregateFeedback(records);
        expect(agg.goodCount).toBe(expectedGood);
        expect(agg.badCount).toBe(expectedBad);
      }),
      { numRuns: 100 }
    );
  });

  it("total > 0 のとき goodRatio === goodCount / total", () => {
    fc.assert(
      fc.property(
        recordSet.filter((records) => records.length > 0),
        (records) => {
          const agg = aggregateFeedback(records);
          expect(agg.total).toBeGreaterThan(0);
          expect(agg.goodRatio).toBe(agg.goodCount / agg.total);
          expect(agg.goodRatio).toBeGreaterThanOrEqual(0);
          expect(agg.goodRatio).toBeLessThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("空集合のとき全カウント 0 かつ goodRatio 0（エラーにならない）", () => {
    const agg = aggregateFeedback([]);
    expect(agg.goodCount).toBe(0);
    expect(agg.badCount).toBe(0);
    expect(agg.total).toBe(0);
    expect(agg.goodRatio).toBe(0);
    expect(agg.badWithComments).toEqual([]);
  });

  it("badWithComments の全要素は sentiment === 'bad'（Bad コメント一覧用）", () => {
    fc.assert(
      fc.property(recordSet, (records) => {
        const agg = aggregateFeedback(records);
        for (const r of agg.badWithComments) {
          expect(r.sentiment).toBe("bad");
        }
        // 過不足なく、入力中の bad レコードと一致する
        expect(agg.badWithComments.length).toBe(agg.badCount);
        const expectedBad = records.filter((r) => r.sentiment === "bad");
        expect(agg.badWithComments).toEqual(expectedBad);
      }),
      { numRuns: 100 }
    );
  });

  it("集計は閲覧者・オーナーに依存せず入力集合全体を反映する（オーナー並べ替えで不変）", () => {
    fc.assert(
      fc.property(recordSet, (records) => {
        const agg = aggregateFeedback(records);
        // ownerUserId でソートしても集計値は変わらない（横断集計・順序非依存）
        const reordered = [...records].sort((a, b) =>
          a.ownerUserId.localeCompare(b.ownerUserId)
        );
        const aggReordered = aggregateFeedback(reordered);
        expect(aggReordered.goodCount).toBe(agg.goodCount);
        expect(aggReordered.badCount).toBe(agg.badCount);
        expect(aggReordered.total).toBe(agg.total);
        expect(aggReordered.goodRatio).toBe(agg.goodRatio);
      }),
      { numRuns: 100 }
    );
  });

  it("複数の distinct owner を含む集合でも total は全レコード件数（横断集計）", () => {
    fc.assert(
      fc.property(
        recordSet.filter(
          (records) => new Set(records.map((r) => r.ownerUserId)).size >= 2
        ),
        (records) => {
          const agg = aggregateFeedback(records);
          // 特定オーナーに限定せず、全オーナーのレコードを合算している
          expect(agg.total).toBe(records.length);
          expect(agg.goodCount + agg.badCount).toBe(records.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("入力配列を変更しない（不変性）", () => {
    fc.assert(
      fc.property(recordSet, (records) => {
        const snapshot = records.map((r) => ({ ...r }));
        aggregateFeedback(records);
        expect(records).toEqual(snapshot);
      }),
      { numRuns: 100 }
    );
  });
});
