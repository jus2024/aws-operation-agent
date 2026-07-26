/**
 * Property-based tests for the (owner, messageId) upsert store
 * （messageFeedbackStore の upsert 不変条件）
 *
 * **Validates: Requirements 4.5, 4.6**
 *
 * Property 6: (owner, messageId) 単位の upsert 不変条件
 * - 任意の good/bad/clear アクション列を適用した後、各 (ownerUserId, messageId)
 *   の組に対応するレコードは高々 1 件しか存在しない（各プレフィックス適用時＝
 *   「すべての時点」でも成り立つ）。
 * - ある組の直近アクションがクリア（明示 clear もしくは同一 sentiment の再押下に
 *   よるクリア）であれば、その組の対応レコードは 0 件（削除済み）である。
 *
 * Tag: Feature: ui-ux-enhancements, Property 6: (owner, messageId) 単位の upsert 不変条件
 */

import fc from "fast-check";
import {
  createStore,
  storeKey,
  applyAction,
  applyActions,
  getRecord,
  type FeedbackAction,
  type MessageFeedbackStore,
} from "./messageFeedbackStore";
import {
  nextFeedbackState,
  type FeedbackSentiment,
  type FeedbackState,
} from "./feedbackState";

// --- Generators ---

/**
 * 小さなキー候補プール。
 * 少数の (owner, messageId) 組に集中させることで、同一キーへの
 * 記録 / 更新 / クリアが繰り返し衝突する状況を意図的に多く生成する。
 */
const OWNERS = ["u1", "u2"] as const;
const MESSAGE_IDS = ["m1", "m2", "m3"] as const;

const owner: fc.Arbitrary<string> = fc.constantFrom(...OWNERS);
const messageId: fc.Arbitrary<string> = fc.constantFrom(...MESSAGE_IDS);
const sentiment: fc.Arbitrary<FeedbackSentiment> = fc.constantFrom(
  "good",
  "bad"
);

/** 任意コメント（null / 空文字 / 短い文字列、Unicode 含む） */
const anyComment: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.string({ maxLength: 40 })
);

/** toggle アクション（任意で comment を伴う） */
const toggleAction: fc.Arbitrary<FeedbackAction> = fc.record({
  kind: fc.constant("toggle" as const),
  ownerUserId: owner,
  messageId,
  activated: sentiment,
  comment: anyComment,
});

/** clear アクション */
const clearAction: fc.Arbitrary<FeedbackAction> = fc.record({
  kind: fc.constant("clear" as const),
  ownerUserId: owner,
  messageId,
});

/** toggle / clear を混在させた 1 アクション */
const anyAction: fc.Arbitrary<FeedbackAction> = fc.oneof(
  { weight: 3, arbitrary: toggleAction },
  { weight: 1, arbitrary: clearAction }
);

/** 任意長のアクション列（空列を含む） */
const actionSequence: fc.Arbitrary<FeedbackAction[]> = fc.array(anyAction, {
  minLength: 0,
  maxLength: 30,
});

// --- Reference model ---

/** すべての (owner, messageId) 組み合わせのキー一覧 */
const ALL_KEYS: Array<{ ownerUserId: string; messageId: string }> = OWNERS.flatMap(
  (o) => MESSAGE_IDS.map((m) => ({ ownerUserId: o, messageId: m }))
);

/**
 * ストアに含まれる (owner, messageId) キーごとのレコード件数を数える。
 * MessageFeedbackStore は Map なのでキー重複は起こり得ないが、
 * レコードの ownerUserId/messageId が storeKey と整合しているかを含めて
 * 実データ上の件数として数える。
 */
function countByKey(store: MessageFeedbackStore): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of store.values()) {
    const key = storeKey(record.ownerUserId, record.messageId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 純粋リデューサに基づく参照状態（キーごとの FeedbackState） */
function referenceState(actions: readonly FeedbackAction[]): Map<string, FeedbackState> {
  const states = new Map<string, FeedbackState>();
  for (const action of actions) {
    const key = storeKey(action.ownerUserId, action.messageId);
    const current: FeedbackState = states.get(key) ?? {
      sentiment: null,
      comment: null,
    };
    if (action.kind === "clear") {
      states.set(key, { sentiment: null, comment: null });
    } else {
      states.set(key, nextFeedbackState(current, action.activated));
    }
  }
  return states;
}

// --- Properties ---

describe("Property 6: (owner, messageId) 単位の upsert 不変条件", () => {
  it("任意のアクション列を適用した後、各キーのレコードは高々 1 件", () => {
    fc.assert(
      fc.property(actionSequence, (actions) => {
        const store = applyActions(createStore(), actions);
        for (const count of countByKey(store).values()) {
          expect(count).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("すべての時点（各プレフィックス適用後）で各キーのレコードは高々 1 件", () => {
    fc.assert(
      fc.property(actionSequence, (actions) => {
        let store = createStore();
        // 空列時点も検証
        for (const count of countByKey(store).values()) {
          expect(count).toBeLessThanOrEqual(1);
        }
        for (const action of actions) {
          store = applyAction(store, action);
          for (const count of countByKey(store).values()) {
            expect(count).toBeLessThanOrEqual(1);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("直近アクションがクリア（明示 clear / 同一 sentiment 再押下）となるキーは 0 件", () => {
    fc.assert(
      fc.property(actionSequence, (actions) => {
        const store = applyActions(createStore(), actions);
        const expected = referenceState(actions);

        for (const { ownerUserId, messageId: mid } of ALL_KEYS) {
          const key = storeKey(ownerUserId, mid);
          const state = expected.get(key);
          const record = getRecord(store, ownerUserId, mid);

          if (state === undefined || state.sentiment === null) {
            // そのキーに触れていない、または直近操作でクリアされた → 0 件
            expect(record).toBeUndefined();
          } else {
            // クリアされていない → ちょうど 1 件、sentiment は参照状態と一致
            expect(record).toBeDefined();
            expect(record?.sentiment).toBe(state.sentiment);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("末尾に clear を付けたキーは必ず 0 件になる", () => {
    fc.assert(
      fc.property(actionSequence, owner, messageId, (actions, o, m) => {
        const withClear: FeedbackAction[] = [
          ...actions,
          { kind: "clear", ownerUserId: o, messageId: m },
        ];
        const store = applyActions(createStore(), withClear);
        expect(getRecord(store, o, m)).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it("同一 sentiment を 2 回連続で押下するとそのキーは 0 件（トグルクリア）", () => {
    fc.assert(
      fc.property(owner, messageId, sentiment, anyComment, (o, m, s, c) => {
        const actions: FeedbackAction[] = [
          { kind: "toggle", ownerUserId: o, messageId: m, activated: s, comment: c },
          { kind: "toggle", ownerUserId: o, messageId: m, activated: s, comment: c },
        ];
        const store = applyActions(createStore(), actions);
        expect(getRecord(store, o, m)).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it("bad を記録するとコメントが保持され、good へ更新するとコメントは破棄される（Req 4.6 の付随不変）", () => {
    fc.assert(
      fc.property(owner, messageId, fc.string({ maxLength: 40 }), (o, m, c) => {
        const afterBad = applyAction(createStore(), {
          kind: "toggle",
          ownerUserId: o,
          messageId: m,
          activated: "bad",
          comment: c,
        });
        expect(getRecord(afterBad, o, m)?.sentiment).toBe("bad");
        expect(getRecord(afterBad, o, m)?.comment).toBe(c);

        const afterGood = applyAction(afterBad, {
          kind: "toggle",
          ownerUserId: o,
          messageId: m,
          activated: "good",
        });
        expect(getRecord(afterGood, o, m)?.sentiment).toBe("good");
        expect(getRecord(afterGood, o, m)?.comment).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it("applyActions は入力ストアを変更しない（不変性）", () => {
    fc.assert(
      fc.property(actionSequence, (actions) => {
        const base = applyActions(createStore(), [
          { kind: "toggle", ownerUserId: "u1", messageId: "m1", activated: "good" },
        ]);
        const snapshot = new Map(base);
        applyActions(base, actions);
        expect(new Map(base)).toEqual(snapshot);
      }),
      { numRuns: 100 }
    );
  });
});
