/**
 * Property-based tests for convertMemoryEventsToAGUIMessages (memoryRestore)
 *
 * **Validates: Requirements 2.6**
 *
 * Property 3: toolUse と toolResult は toolUseId によって一意に紐付く
 * - 任意の assistant イベントの toolUse ブロック（toolUseId を持つ）とその後に
 *   続く user イベントの toolResult ブロック（同じ toolUseId を持つ）の組に対して、
 *   convertMemoryEventsToAGUIMessages が構築するツールカード相当のメッセージ構造は、
 *   当該 toolUseId を持つ toolResult を、同じ toolUseId を持つ toolUse に対応する
 *   ツールカードにのみ結び付け、異なる toolUseId を持つ他の toolUse/toolResult の
 *   組と混同しない。
 *
 * Tag: Feature: memory-based-chat-history, Property 3: toolUse と toolResult は toolUseId によって一意に紐付く
 */

import fc from "fast-check";
import { convertMemoryEventsToAGUIMessages } from "./memoryRestore";

type ParsedEvent = { role: "user" | "assistant"; content: unknown[] };

/** toolUseId として使う一意な識別子（互いに区別できる程度に多様な文字列） */
const toolUseIdArb = fc
  .tuple(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0), fc.nat())
  .map(([s, n]) => `tu-${n}-${s.replace(/\s/g, "_")}`);

/**
 * N 個の一意な toolUseId を生成し、各 toolUseId につき
 * (assistant の toolUse イベント, user の toolResult イベント) のペアを構築する。
 */
const toolUseResultPairsArb = fc
  .uniqueArray(toolUseIdArb, { minLength: 2, maxLength: 10 })
  .map((toolUseIds) =>
    toolUseIds.map((toolUseId) => ({
      toolUseId,
      toolName: `tool-${toolUseId}`,
      resultContent: `result-for-${toolUseId}`,
      toolUseEvent: {
        role: "assistant" as const,
        content: [{ toolUse: { toolUseId, name: `tool-${toolUseId}`, input: { marker: toolUseId } } }],
      } satisfies ParsedEvent,
      toolResultEvent: {
        role: "user" as const,
        content: [{ toolResult: { toolUseId, content: `result-for-${toolUseId}` } }],
      } satisfies ParsedEvent,
    }))
  );

describe("Property 3: toolUse と toolResult は toolUseId によって一意に紐付く", () => {
  it("各 toolUseId の toolCall/toolResult メッセージは、対応する toolUseId のデータのみを保持し、他の組と混同しない", () => {
    fc.assert(
      fc.property(toolUseResultPairsArb, (pairs) => {
          // toolUse イベントと toolResult イベントを任意の順序で混在させる
          // （toolResult は「その後に続く」想定だが、紐付けは toolUseId のみで
          // 行われるため、順序に依存しないことも同時に検証する）。
          const allEvents: ParsedEvent[] = [];
          for (const pair of pairs) {
            allEvents.push(pair.toolUseEvent, pair.toolResultEvent);
          }

          const messages = convertMemoryEventsToAGUIMessages(allEvents);

          for (const pair of pairs) {
            const toolCallMessages = messages.filter(
              (m): m is Extract<(typeof messages)[number], { role: "assistant"; toolCallId: string }> =>
                m.role === "assistant" && "toolCallId" in m && m.toolCallId === pair.toolUseId
            );
            const toolResultMessages = messages.filter(
              (m): m is Extract<(typeof messages)[number], { role: "tool" }> =>
                m.role === "tool" && m.toolCallId === pair.toolUseId
            );

            // 各 toolUseId につき、toolCall メッセージ・toolResult メッセージが
            // ちょうど1件だけ存在すること
            expect(toolCallMessages.length).toBe(1);
            expect(toolResultMessages.length).toBe(1);

            // toolCall メッセージは自身の toolUseId に対応するデータのみを持つこと
            // （他の組の name/args と混同されていないこと）
            expect(toolCallMessages[0].toolCallName).toBe(pair.toolName);
            expect(toolCallMessages[0].toolCallArgs).toEqual({ marker: pair.toolUseId });

            // toolResult メッセージは自身の toolUseId に対応する結果のみを持つこと
            expect(toolResultMessages[0].content).toBe(pair.resultContent);
          }

          // 全体として toolCall/toolResult メッセージの件数が組数と一致すること
          // （他の組のデータが漏れ込んで余剰メッセージが生成されていないこと）
          const totalToolCallMessages = messages.filter((m) => m.role === "assistant" && "toolCallId" in m);
          const totalToolResultMessages = messages.filter((m) => m.role === "tool");
          expect(totalToolCallMessages.length).toBe(pairs.length);
          expect(totalToolResultMessages.length).toBe(pairs.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("toolUse と toolResult の順序を入れ替えても、紐付けは toolUseId のみで決まり混同しない", () => {
    fc.assert(
      fc.property(toolUseResultPairsArb, (pairs) => {
        // toolResult を先に、toolUse を後に並べる（「その後に続く」想定と逆順）
        const allEvents: ParsedEvent[] = [];
        for (const pair of pairs) {
          allEvents.push(pair.toolResultEvent, pair.toolUseEvent);
        }

        const messages = convertMemoryEventsToAGUIMessages(allEvents);

        for (const pair of pairs) {
          const toolCallMessage = messages.find(
            (m) => m.role === "assistant" && "toolCallId" in m && m.toolCallId === pair.toolUseId
          );
          const toolResultMessage = messages.find((m) => m.role === "tool" && m.toolCallId === pair.toolUseId);

          expect(toolCallMessage).toBeDefined();
          expect(toolResultMessage).toBeDefined();
          if (toolCallMessage && "toolCallName" in toolCallMessage) {
            expect(toolCallMessage.toolCallName).toBe(pair.toolName);
          }
          if (toolResultMessage && "content" in toolResultMessage) {
            expect(toolResultMessage.content).toBe(pair.resultContent);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
