/**
 * Property-based tests for the full memoryRestore conversion pipeline
 * (filterConversationalEvents → parseConversationalEventPayload →
 * convertMemoryEventsToAGUIMessages), verifying idempotency across
 * repeated executions on the same input.
 *
 * **Validates: Requirements 2.3**
 *
 * Property 6: 同一セッションの再取得は常に同一の結果を返す（重複防止）
 * - 固定された MemoryEvent のリスト（Memory 側の状態が変化しない）に対して、
 *   filterConversationalEvents → parseConversationalEventPayload →
 *   convertMemoryEventsToAGUIMessages の変換パイプラインを複数回実行した結果は、
 *   実行回数に関わらず常に同一の AGUIMessage リストを返す（要素が累積したり
 *   増減したりしない）。
 *
 * Tag: Feature: memory-based-chat-history, Property 6: 同一セッションの再取得は常に同一の結果を返す（重複防止）
 */

import fc from "fast-check";
import {
  filterConversationalEvents,
  parseConversationalEventPayload,
  convertMemoryEventsToAGUIMessages,
  type MemoryEvent,
} from "./memoryRestore";

// --- Generators ---

/** message.role/message.content が期待形式に沿った、有効な JSON 文字列を生成する */
const validMessageJsonText: fc.Arbitrary<string> = fc
  .record({
    role: fc.constantFrom("user", "assistant"),
    content: fc.array(
      fc.oneof(
        fc.record({ text: fc.string() }),
        fc.record({
          toolUse: fc.record({
            toolUseId: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `tu-${s}`),
            name: fc.string({ minLength: 1, maxLength: 10 }),
            input: fc.dictionary(fc.string(), fc.jsonValue()),
          }),
        }),
        fc.record({
          toolResult: fc.record({
            toolUseId: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `tu-${s}`),
            content: fc.string(),
          }),
        })
      ),
      { minLength: 0, maxLength: 4 }
    ),
  })
  .map((message) => JSON.stringify({ message }));

/** JSON としてパースできない任意の文字列を生成する（不正ペイロードのケース） */
const unparsableJsonText: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => {
    try {
      JSON.parse(s);
      return false;
    } catch {
      return true;
    }
  });

/**
 * JSON としてはパースできるが、message.role/message.content が期待形式で
 * ない文字列を生成する（不正ペイロードのケース）
 */
const parsableButInvalidShapeJsonText: fc.Arbitrary<string> = fc.oneof(
  fc.jsonValue().map((v) => JSON.stringify({ notMessage: v })),
  fc
    .record({
      role: fc.string().filter((s) => s !== "user" && s !== "assistant"),
      content: fc.array(fc.jsonValue()),
    })
    .map((message) => JSON.stringify({ message }))
);

/** 有効・無効の両方を混在させた conversational イベントの text ジェネレーター */
const conversationalText: fc.Arbitrary<string> = fc.oneof(
  validMessageJsonText,
  unparsableJsonText,
  parsableButInvalidShapeJsonText
);

/** conversational payload を持つ MemoryEvent（有効/無効な JSON が混在する） */
const conversationalEvent: fc.Arbitrary<MemoryEvent> = fc.record({
  eventId: fc.uuid(),
  eventTimestamp: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  payload: fc
    .record({
      role: fc.constantFrom("USER", "ASSISTANT"),
      text: conversationalText,
    })
    .map(({ role, text }) => [{ conversational: { role, content: { text } } }]),
});

/** blob payload を持つ MemoryEvent（AGENT/SESSION 状態イベント相当、パイプラインの入力に混在させる） */
const blobEvent: fc.Arbitrary<MemoryEvent> = fc.record({
  eventId: fc.uuid(),
  eventTimestamp: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  payload: fc.jsonValue().map((blobValue) => [{ blob: blobValue }]),
});

/** conversational（有効/無効な JSON 混在）と blob が任意の順序・割合で混在する MemoryEvent のリスト */
const mixedEventListArb: fc.Arbitrary<MemoryEvent[]> = fc.array(fc.oneof(conversationalEvent, blobEvent), {
  minLength: 0,
  maxLength: 30,
});

/**
 * design.md が定義するパイプラインを実行する:
 * filterConversationalEvents → parseConversationalEventPayload（各イベントに適用）
 * → パース失敗（null）を除外 → convertMemoryEventsToAGUIMessages
 */
function runPipeline(events: MemoryEvent[]) {
  const conversationalEvents = filterConversationalEvents(events);
  const parsedEvents = conversationalEvents
    .map((event) => parseConversationalEventPayload(event))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);
  return convertMemoryEventsToAGUIMessages(parsedEvents);
}

// --- Property ---

describe("Property 6: 同一セッションの再取得は常に同一の結果を返す（重複防止）", () => {
  it("同一入力でパイプラインを複数回実行しても、常に同一の AGUIMessage リストを返す", () => {
    fc.assert(
      fc.property(mixedEventListArb, (events) => {
        const firstRun = runPipeline(events);
        const secondRun = runPipeline(events);
        const thirdRun = runPipeline(events);

        expect(secondRun).toEqual(firstRun);
        expect(thirdRun).toEqual(firstRun);

        // 要素数が実行回数によらず一定であること（累積・増減しないこと）を明示的に確認する
        expect(secondRun.length).toBe(firstRun.length);
        expect(thirdRun.length).toBe(firstRun.length);
      }),
      { numRuns: 100 }
    );
  });

  it("同一入力を5回連続で実行しても結果が変化しない（繰り返しセッション切り替えの模擬）", () => {
    fc.assert(
      fc.property(mixedEventListArb, (events) => {
        const results = Array.from({ length: 5 }, () => runPipeline(events));

        for (let i = 1; i < results.length; i++) {
          expect(results[i]).toEqual(results[0]);
        }
      }),
      { numRuns: 100 }
    );
  });
});
