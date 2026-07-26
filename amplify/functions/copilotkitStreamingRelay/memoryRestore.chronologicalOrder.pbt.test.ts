/**
 * Property-based tests for convertMemoryEventsToAGUIMessages (memoryRestore)
 *
 * **Validates: Requirements 2.2**
 *
 * Property 4: 変換後のメッセージ列は時系列順序を保存する
 * - eventTimestamp の昇順で並んだ MemoryEvent のリスト（本テストでは既に
 *   filterConversationalEvents → parseConversationalEventPayload を経て
 *   パース成功したイベントのみが convertMemoryEventsToAGUIMessages に渡される
 *   前提を反映し、パース済みイベント列 `{role, content}[]` を直接生成する）に
 *   対して、convertMemoryEventsToAGUIMessages が返す AGUIMessage のリストは、
 *   元のイベント列と対応する順序関係を保ったまま並ぶ（残りの要素間の相対順序が
 *   逆転しない）。
 *
 * Tag: Feature: memory-based-chat-history, Property 4: 変換後のメッセージ列は時系列順序を保存する
 */

import fc from "fast-check";
import { convertMemoryEventsToAGUIMessages } from "./memoryRestore";

type ParsedEvent = { role: "user" | "assistant"; content: unknown[] };

/** イベントを一意に追跡するためのマーカーを埋め込んだ text ブロックを持つ assistant/user イベント */
const markedTextEventArb = (marker: number): fc.Arbitrary<ParsedEvent> =>
  fc.constantFrom<"user" | "assistant">("user", "assistant").map((role) => ({
    role,
    content: [{ text: `msg-${marker}` }],
  }));

/**
 * 一意な連番マーカーを持つ text イベントのリストを生成する。
 * 各イベントはちょうど1つの AGUIMessage に変換される（text ブロック1つ）ため、
 * 出力メッセージ列の順序を入力イベント列の順序と直接比較できる。
 */
const markedEventListArb: fc.Arbitrary<ParsedEvent[]> = fc
  .integer({ min: 0, max: 30 })
  .chain((length) => fc.tuple(...Array.from({ length }, (_, i) => markedTextEventArb(i))));

describe("Property 4: 変換後のメッセージ列は時系列順序を保存する", () => {
  it("text イベントのみの場合、出力メッセージの順序は入力イベントの順序と完全に一致する", () => {
    fc.assert(
      fc.property(markedEventListArb, (events) => {
        const messages = convertMemoryEventsToAGUIMessages(events);

        expect(messages.length).toBe(events.length);

        const expectedContents = events.map((_, i) => `msg-${i}`);
        const actualContents = messages.map((m) => ("content" in m ? m.content : undefined));

        expect(actualContents).toEqual(expectedContents);
      }),
      { numRuns: 100 }
    );
  });

  it("text ブロックと toolUse/toolResult ブロックが混在しても、各イベント由来のメッセージの相対順序は逆転しない", () => {
    const toolUseIdArb = fc
      .tuple(fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim().length > 0), fc.nat())
      .map(([s, n]) => `tu-${n}-${s.replace(/\s/g, "_")}`);

    const eventKindArb = fc.oneof(
      toolUseIdArb.map((toolUseId) => ({
        kind: "assistant-text-or-tooluse" as const,
        toolUseId,
      })),
      fc.constant({ kind: "plain" as const })
    );

    fc.assert(
      fc.property(fc.array(eventKindArb, { minLength: 0, maxLength: 20 }), (kinds) => {
        // 連番マーカーを各イベントに割り当て、イベントインデックスの昇順を
        // 「元の時系列順序」として扱う。
        const events: ParsedEvent[] = kinds.map((kind, index) => {
          if (kind.kind === "assistant-text-or-tooluse") {
            return {
              role: "assistant",
              content: [
                { text: `marker-${index}` },
                { toolUse: { toolUseId: kind.toolUseId, name: "t", input: {} } },
              ],
            };
          }
          return { role: "user", content: [{ text: `marker-${index}` }] };
        });

        const messages = convertMemoryEventsToAGUIMessages(events);

        // text ブロックから生成されたメッセージのみを抽出し、そこに埋め込んだ
        // marker-{index} の index 列が昇順（元の順序を保存）であることを確認する。
        const markerIndices = messages
          .filter((m): m is { id: string; role: "user" | "assistant"; content: string } => "content" in m)
          .map((m) => m.content)
          .filter((content): content is string => typeof content === "string" && content.startsWith("marker-"))
          .map((content) => Number(content.slice("marker-".length)));

        for (let i = 1; i < markerIndices.length; i++) {
          expect(markerIndices[i]).toBeGreaterThan(markerIndices[i - 1]);
        }
      }),
      { numRuns: 100 }
    );
  });
});
