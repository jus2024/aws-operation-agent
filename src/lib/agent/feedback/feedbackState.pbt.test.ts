/**
 * Property-based tests for nextFeedbackState (Feedback トグルリデューサ)
 *
 * **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 3.6**
 *
 * Property 4: Feedback トグルリデューサ
 * - (a) current.sentiment === null（フィードバックなし）→ 結果は activated
 * - (b) current.sentiment が activated と反対 → 結果は activated
 *       （activated === good で bad から遷移した場合、comment は破棄され null）
 * - (c) current.sentiment === activated（同一押下）→ 結果は null（クリア）
 * - 結果の sentiment が "bad" でない場合、結果の comment は常に null
 *
 * Tag: Feature: ui-ux-enhancements, Property 4: Feedback トグルリデューサ
 */

import fc from "fast-check";
import {
  nextFeedbackState,
  FeedbackSentiment,
  FeedbackState,
  isValidComment,
  FEEDBACK_COMMENT_MAX,
} from "./feedbackState";

// --- Generators ---

/** 押下される sentiment: good または bad */
const sentiment: fc.Arbitrary<FeedbackSentiment> = fc.constantFrom(
  "good",
  "bad"
);

/** 現在の sentiment: good / bad / null（フィードバックなし） */
const currentSentiment: fc.Arbitrary<FeedbackSentiment | null> =
  fc.constantFrom("good", "bad", null);

/** 任意の comment（null / 空文字 / 任意文字列、Unicode 含む） */
const anyComment: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.string({ maxLength: 200 })
);

/** 任意の現在状態（sentiment × comment の全組合せ） */
const anyState: fc.Arbitrary<FeedbackState> = fc.record({
  sentiment: currentSentiment,
  comment: anyComment,
});

// --- Properties ---

describe("Property 4: Feedback トグルリデューサ", () => {
  it("(a) フィードバックなし（sentiment === null）→ 結果は activated", () => {
    fc.assert(
      fc.property(anyComment, sentiment, (comment, activated) => {
        const current: FeedbackState = { sentiment: null, comment };
        const next = nextFeedbackState(current, activated);
        expect(next.sentiment).toBe(activated);
      }),
      { numRuns: 100 }
    );
  });

  it("(b) 反対 sentiment 押下 → 結果は activated に更新", () => {
    fc.assert(
      fc.property(anyComment, sentiment, (comment, activated) => {
        const opposite: FeedbackSentiment =
          activated === "good" ? "bad" : "good";
        const current: FeedbackState = { sentiment: opposite, comment };
        const next = nextFeedbackState(current, activated);
        expect(next.sentiment).toBe(activated);
      }),
      { numRuns: 100 }
    );
  });

  it("(b) bad → good の遷移では comment が破棄され null になる（Req 3.6）", () => {
    fc.assert(
      fc.property(anyComment, (comment) => {
        const current: FeedbackState = { sentiment: "bad", comment };
        const next = nextFeedbackState(current, "good");
        expect(next.sentiment).toBe("good");
        expect(next.comment).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it("(c) 同一 sentiment 押下 → クリア（結果は null）", () => {
    fc.assert(
      fc.property(anyComment, sentiment, (comment, activated) => {
        const current: FeedbackState = { sentiment: activated, comment };
        const next = nextFeedbackState(current, activated);
        expect(next.sentiment).toBeNull();
        expect(next.comment).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it("結果の sentiment が 'bad' でない場合、comment は常に null", () => {
    fc.assert(
      fc.property(anyState, sentiment, (current, activated) => {
        const next = nextFeedbackState(current, activated);
        if (next.sentiment !== "bad") {
          expect(next.comment).toBeNull();
        }
      }),
      { numRuns: 100 }
    );
  });

  it("結果は 3 遷移規則のいずれかに厳密に従う（全域の網羅検証）", () => {
    fc.assert(
      fc.property(anyState, sentiment, (current, activated) => {
        const next = nextFeedbackState(current, activated);
        if (current.sentiment === activated) {
          // (c) クリア
          expect(next).toEqual({ sentiment: null, comment: null });
        } else {
          // (a) none + activated / (b) 反対からの更新
          expect(next).toEqual({ sentiment: activated, comment: null });
        }
      }),
      { numRuns: 100 }
    );
  });

  it("current を変更しない（不変性）", () => {
    fc.assert(
      fc.property(anyState, sentiment, (current, activated) => {
        const snapshot: FeedbackState = { ...current };
        nextFeedbackState(current, activated);
        expect(current).toEqual(snapshot);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 5: Feedback_Comment 長さバリデーション
 *
 * isValidComment(c) === (c.length <= FEEDBACK_COMMENT_MAX) (= 1000)
 * - 長さ 1000 は有効、1001 は無効、空文字は有効。
 *
 * Tag: Feature: ui-ux-enhancements, Property 5: Feedback_Comment 長さバリデーション
 *
 * **Validates: Requirements 3.5**
 */
describe("Property 5: Feedback_Comment 長さバリデーション", () => {
  // --- Generators（この describe 内にローカル定義し、Property 4 と衝突させない） ---

  /** 長さを正確に制御した ASCII 文字列（境界 1000/1001 を確実にヒットさせる） */
  const exactLengthComment: fc.Arbitrary<string> = fc
    .integer({ min: 0, max: 2000 })
    .map((n) => "a".repeat(n));

  /** Unicode を含む任意文字列（.length は UTF-16 コードユニット数） */
  const unicodeComment: fc.Arbitrary<string> = fc.string({ maxLength: 2000 });

  /** 境界近傍を明示的に含めたコメント生成器 */
  const boundaryComment: fc.Arbitrary<string> = fc.oneof(
    fc.constant(""),
    fc.constant("a".repeat(FEEDBACK_COMMENT_MAX - 1)),
    fc.constant("a".repeat(FEEDBACK_COMMENT_MAX)),
    fc.constant("a".repeat(FEEDBACK_COMMENT_MAX + 1)),
    exactLengthComment,
    unicodeComment
  );

  it("isValidComment(c) は c.length <= FEEDBACK_COMMENT_MAX と一致する", () => {
    fc.assert(
      fc.property(boundaryComment, (comment) => {
        expect(isValidComment(comment)).toBe(
          comment.length <= FEEDBACK_COMMENT_MAX
        );
      }),
      { numRuns: 100 }
    );
  });

  it("長さ 1000 ちょうどは有効、1001 は無効、空文字は有効", () => {
    expect(FEEDBACK_COMMENT_MAX).toBe(1000);
    expect(isValidComment("")).toBe(true);
    expect(isValidComment("a".repeat(FEEDBACK_COMMENT_MAX))).toBe(true);
    expect(isValidComment("a".repeat(FEEDBACK_COMMENT_MAX + 1))).toBe(false);
  });

  it("長さ <= 1000 の任意コメントは常に有効", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: FEEDBACK_COMMENT_MAX }).map((n) => "a".repeat(n)),
        (comment) => {
          expect(isValidComment(comment)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("長さ > 1000 の任意コメントは常に無効", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: FEEDBACK_COMMENT_MAX + 1, max: 3000 })
          .map((n) => "a".repeat(n)),
        (comment) => {
          expect(isValidComment(comment)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
