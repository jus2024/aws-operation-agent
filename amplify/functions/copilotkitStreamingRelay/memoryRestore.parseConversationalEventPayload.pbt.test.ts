/**
 * Property-based tests for parseConversationalEventPayload (memoryRestore)
 *
 * **Validates: Requirements 2.7**
 *
 * Property 2: 不正なペイロードは常に安全にフォールバックする
 * - 任意の MemoryEvent（payload[0].conversational.content.text が有効な JSON
 *   文字列である場合と、JSON として解釈できない文字列・期待する
 *   message.role/message.content の形を持たない場合の両方を含む）に対して、
 *   parseConversationalEventPayload は例外を投げず、有効な場合は
 *   { role, content } を返し、無効な場合は常に null を返す。
 *
 * Tag: Feature: memory-based-chat-history, Property 2: 不正なペイロードは常に安全にフォールバックする
 */

import fc from "fast-check";
import { parseConversationalEventPayload, type MemoryEvent } from "./memoryRestore";

// --- Generators ---

/** 有効な message.role/message.content を持つ JSON 文字列を生成する */
const validMessageJsonText: fc.Arbitrary<string> = fc
  .record({
    role: fc.constantFrom("user", "assistant"),
    content: fc.array(fc.jsonValue(), { minLength: 0, maxLength: 5 }),
  })
  .map((message) => JSON.stringify({ message }));

/** JSON としてパースできない任意の文字列を生成する */
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
 * ない文字列を生成する（message が無い、role が不正値、content が配列でない等）
 */
const parsableButInvalidShapeJsonText: fc.Arbitrary<string> = fc.oneof(
  // message フィールド自体が存在しない
  fc.jsonValue().map((v) => JSON.stringify({ notMessage: v })),
  // message.role が user/assistant 以外
  fc
    .record({
      role: fc.string().filter((s) => s !== "user" && s !== "assistant"),
      content: fc.array(fc.jsonValue()),
    })
    .map((message) => JSON.stringify({ message })),
  // message.content が配列でない
  fc
    .record({
      role: fc.constantFrom("user", "assistant"),
      content: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
    })
    .map((message) => JSON.stringify({ message })),
  // トップレベルが配列やプリミティブ（object でない）
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.jsonValue())).map((v) => JSON.stringify(v))
);

/** 有効・無効の両方を混在させたテキストのジェネレーター */
const conversationalText: fc.Arbitrary<string> = fc.oneof(
  validMessageJsonText,
  unparsableJsonText,
  parsableButInvalidShapeJsonText
);

/** conversational payload を持つ MemoryEvent（content.text は上記のいずれか） */
const conversationalMemoryEvent: fc.Arbitrary<MemoryEvent> = fc
  .record({
    eventId: fc.uuid(),
    eventTimestamp: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
    eventRole: fc.constantFrom("USER", "ASSISTANT"),
    text: conversationalText,
  })
  .map(({ eventId, eventTimestamp, eventRole, text }) => ({
    eventId,
    eventTimestamp,
    payload: [{ conversational: { role: eventRole, content: { text } } }],
  }));

// --- Properties ---

describe("Property 2: 不正なペイロードは常に安全にフォールバックする", () => {
  it("例外を投げず、有効な場合は {role, content} を、無効な場合は null を返す", () => {
    fc.assert(
      fc.property(conversationalMemoryEvent, (event) => {
        let result: ReturnType<typeof parseConversationalEventPayload>;

        expect(() => {
          result = parseConversationalEventPayload(event);
        }).not.toThrow();

        const firstPayloadItem = event.payload[0];
        const text =
          firstPayloadItem !== undefined && "conversational" in firstPayloadItem
            ? firstPayloadItem.conversational.content.text
            : undefined;

        let expectedParsedOk = false;
        let expectedRole: unknown;
        let expectedContent: unknown;
        if (text !== undefined) {
          try {
            const parsed = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null) {
              const message = (parsed as { message?: unknown }).message;
              if (typeof message === "object" && message !== null) {
                const role = (message as { role?: unknown }).role;
                const content = (message as { content?: unknown }).content;
                if ((role === "user" || role === "assistant") && Array.isArray(content)) {
                  expectedParsedOk = true;
                  expectedRole = role;
                  expectedContent = content;
                }
              }
            }
          } catch {
            expectedParsedOk = false;
          }
        }

        if (expectedParsedOk) {
          expect(result).toEqual({ role: expectedRole, content: expectedContent });
        } else {
          expect(result).toBeNull();
        }
      }),
      { numRuns: 100 }
    );
  });

  it("有効な JSON テキストのみを与えた場合は常に {role, content} を返す", () => {
    fc.assert(
      fc.property(
        validMessageJsonText,
        fc.constantFrom("USER", "ASSISTANT"),
        fc.uuid(),
        (text, role, eventId) => {
          const event: MemoryEvent = {
            eventId,
            eventTimestamp: new Date().toISOString(),
            payload: [{ conversational: { role, content: { text } } }],
          };

          const result = parseConversationalEventPayload(event);
          expect(result).not.toBeNull();
          expect(result?.role === "user" || result?.role === "assistant").toBe(true);
          expect(Array.isArray(result?.content)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("パース不能な文字列のみを与えた場合は常に null を返す", () => {
    fc.assert(
      fc.property(unparsableJsonText, fc.constantFrom("USER", "ASSISTANT"), fc.uuid(), (text, role, eventId) => {
        const event: MemoryEvent = {
          eventId,
          eventTimestamp: new Date().toISOString(),
          payload: [{ conversational: { role, content: { text } } }],
        };

        expect(parseConversationalEventPayload(event)).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it("blob payload のイベントに対しては常に null を返す", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.uuid(), fc.date({ noInvalidDate: true }), (blobValue, eventId, timestamp) => {
        const event: MemoryEvent = {
          eventId,
          eventTimestamp: timestamp.toISOString(),
          payload: [{ blob: blobValue }],
        };

        expect(parseConversationalEventPayload(event)).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});
