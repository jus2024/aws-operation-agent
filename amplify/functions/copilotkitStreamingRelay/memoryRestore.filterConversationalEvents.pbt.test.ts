/**
 * Property-based tests for filterConversationalEvents (memoryRestore)
 *
 * **Validates: Requirements 2.2**
 *
 * Property 1: conversational イベントのみが残る（AGENT/SESSION 状態イベントの除外）
 * - 任意の MemoryEvent のリスト（payload[0].conversational を持つイベントと
 *   payload[0].blob を持つイベントが任意の順序・任意の割合で混在する）に対して、
 *   filterConversationalEvents が返すリストは
 *   (a) 入力のうち payload[0].conversational を持つイベントのみを含み、
 *       payload[0].blob を持つイベントを1件も含まない
 *   (b) 残ったイベントの相対順序は入力における順序と同一である
 *
 * Tag: Feature: memory-based-chat-history, Property 1: conversational イベントのみが残る
 */

import fc from "fast-check";
import { filterConversationalEvents, type MemoryEvent } from "./memoryRestore";

// --- Generators ---

/** conversational payload を持つ MemoryEvent（role/content.text は任意文字列） */
const conversationalEvent: fc.Arbitrary<MemoryEvent> = fc.record({
  eventId: fc.uuid(),
  eventTimestamp: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  payload: fc
    .record({
      role: fc.constantFrom("USER", "ASSISTANT"),
      text: fc.string(),
    })
    .map(({ role, text }) => [{ conversational: { role, content: { text } } }]),
});

/** blob payload を持つ MemoryEvent（AGENT/SESSION 状態イベント相当） */
const blobEvent: fc.Arbitrary<MemoryEvent> = fc.record({
  eventId: fc.uuid(),
  eventTimestamp: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  payload: fc.jsonValue().map((blobValue) => [{ blob: blobValue }]),
});

/** conversational と blob が任意の順序・割合で混在する MemoryEvent のリスト */
const mixedEventList: fc.Arbitrary<MemoryEvent[]> = fc.array(
  fc.oneof(conversationalEvent, blobEvent),
  { minLength: 0, maxLength: 50 }
);

// --- Properties ---

describe("Property 1: conversational イベントのみが残る", () => {
  it("(a) 返却リストは conversational イベントのみを含み、blob イベントを含まない", () => {
    fc.assert(
      fc.property(mixedEventList, (events) => {
        const result = filterConversationalEvents(events);

        for (const event of result) {
          const firstPayloadItem = event.payload[0];
          expect(firstPayloadItem).toBeDefined();
          expect("conversational" in firstPayloadItem!).toBe(true);
          expect("blob" in firstPayloadItem!).toBe(false);
        }

        // 件数が入力中の conversational イベント数と一致すること
        const expectedCount = events.filter(
          (e) => e.payload[0] !== undefined && "conversational" in e.payload[0]
        ).length;
        expect(result.length).toBe(expectedCount);
      }),
      { numRuns: 100 }
    );
  });

  it("(b) 残ったイベントの相対順序は入力における順序と同一である", () => {
    fc.assert(
      fc.property(mixedEventList, (events) => {
        const result = filterConversationalEvents(events);

        // 入力中の conversational イベントを eventId で抽出した順序と、
        // 出力の eventId 順序が一致することを確認する
        const expectedOrder = events
          .filter((e) => e.payload[0] !== undefined && "conversational" in e.payload[0])
          .map((e) => e.eventId);
        const actualOrder = result.map((e) => e.eventId);

        expect(actualOrder).toEqual(expectedOrder);
      }),
      { numRuns: 100 }
    );
  });
});
