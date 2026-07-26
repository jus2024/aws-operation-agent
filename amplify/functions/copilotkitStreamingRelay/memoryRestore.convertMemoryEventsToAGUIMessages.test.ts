/**
 * Unit tests for convertMemoryEventsToAGUIMessages (memoryRestore), using
 * fixtures modeled on the actual `list-events` payload shapes observed for
 * AgentCore Memory (Bedrock Converse API content block shapes):
 * - an assistant message with a `toolUse` content block
 * - a user message with a matching `toolResult` content block (same toolUseId)
 * - plain text-only user/assistant messages
 *
 * Requirements: 2.2, 2.6
 */

import { convertMemoryEventsToAGUIMessages } from "./memoryRestore";

describe("convertMemoryEventsToAGUIMessages (fixture-based)", () => {
  it("converts a plain text-only conversation (no tool calls) into text messages in order", () => {
    const parsedEvents = [
      { role: "user" as const, content: [{ text: "こんにちは" }] },
      { role: "assistant" as const, content: [{ text: "こんにちは、ご用件は何ですか？" }] },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      { id: "event-0-text-0", role: "user", content: "こんにちは" },
      { id: "event-1-text-0", role: "assistant", content: "こんにちは、ご用件は何ですか？" },
    ]);
  });

  it("converts an assistant toolUse block and a subsequent user toolResult block into linked tool-card messages", () => {
    // Modeled on an actual list-events payload: assistant message contains a
    // toolUse content block, followed (chronologically) by a user message
    // containing the corresponding toolResult content block with the same toolUseId.
    const parsedEvents = [
      {
        role: "user" as const,
        content: [{ text: "AWS のコストを教えて" }],
      },
      {
        role: "assistant" as const,
        content: [
          { text: "コストを確認します。" },
          {
            toolUse: {
              toolUseId: "tooluse_abc123",
              name: "get_cost_and_usage",
              input: { granularity: "MONTHLY" },
            },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            toolResult: {
              toolUseId: "tooluse_abc123",
              content: [{ text: '{"total": "12.34 USD"}' }],
            },
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [{ text: "今月のコストは12.34 USDです。" }],
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      { id: "event-0-text-0", role: "user", content: "AWS のコストを教えて" },
      { id: "event-1-text-0", role: "assistant", content: "コストを確認します。" },
      {
        id: "toolcall-tooluse_abc123",
        role: "assistant",
        toolCallId: "tooluse_abc123",
        toolCallName: "get_cost_and_usage",
        toolCallArgs: { granularity: "MONTHLY" },
      },
      {
        id: "toolresult-tooluse_abc123",
        role: "tool",
        toolCallId: "tooluse_abc123",
        content: JSON.stringify([{ text: '{"total": "12.34 USD"}' }]),
      },
      { id: "event-3-text-0", role: "assistant", content: "今月のコストは12.34 USDです。" },
    ]);
  });

  it("keeps multiple distinct toolUse/toolResult pairs from being confused with each other", () => {
    const parsedEvents = [
      {
        role: "assistant" as const,
        content: [{ toolUse: { toolUseId: "tu-1", name: "toolA", input: { x: 1 } } }],
      },
      {
        role: "assistant" as const,
        content: [{ toolUse: { toolUseId: "tu-2", name: "toolB", input: { x: 2 } } }],
      },
      {
        role: "user" as const,
        content: [{ toolResult: { toolUseId: "tu-1", content: "result-1" } }],
      },
      {
        role: "user" as const,
        content: [{ toolResult: { toolUseId: "tu-2", content: "result-2" } }],
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    const toolCallTu1 = messages.find((m) => "toolCallId" in m && m.toolCallId === "tu-1");
    const toolCallTu2 = messages.find((m) => "toolCallId" in m && m.toolCallId === "tu-2");
    const toolResultTu1 = messages.find((m) => m.role === "tool" && m.toolCallId === "tu-1");
    const toolResultTu2 = messages.find((m) => m.role === "tool" && m.toolCallId === "tu-2");

    expect(toolCallTu1).toMatchObject({ toolCallName: "toolA", toolCallArgs: { x: 1 } });
    expect(toolCallTu2).toMatchObject({ toolCallName: "toolB", toolCallArgs: { x: 2 } });
    expect(toolResultTu1).toMatchObject({ content: "result-1" });
    expect(toolResultTu2).toMatchObject({ content: "result-2" });
  });

  it("returns an empty array for an empty input list", () => {
    expect(convertMemoryEventsToAGUIMessages([])).toEqual([]);
  });

  it("stamps createdAt (epoch ms) from each event's eventTimestamp when present", () => {
    const parsedEvents = [
      {
        role: "user" as const,
        content: [{ text: "こんにちは" }],
        eventTimestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        role: "assistant" as const,
        content: [
          { text: "確認します。" },
          { toolUse: { toolUseId: "tu-1", name: "toolA", input: { x: 1 } } },
        ],
        eventTimestamp: "2024-01-01T00:00:05.000Z",
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      {
        id: "event-0-text-0",
        role: "user",
        content: "こんにちは",
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
      {
        id: "event-1-text-0",
        role: "assistant",
        content: "確認します。",
        createdAt: Date.parse("2024-01-01T00:00:05.000Z"),
      },
      {
        id: "toolcall-tu-1",
        role: "assistant",
        toolCallId: "tu-1",
        toolCallName: "toolA",
        toolCallArgs: { x: 1 },
        createdAt: Date.parse("2024-01-01T00:00:05.000Z"),
      },
    ]);
  });

  it("stamps createdAt on a restored multimodal (text+image) user turn from its eventTimestamp", () => {
    const B64 = "aGVsbG8=";
    const parsedEvents = [
      {
        role: "user" as const,
        content: [
          { text: "この画像を見て" },
          { image: { format: "png", source: { bytes: { __bytes_encoded__: true, data: B64 } } } },
        ],
        eventTimestamp: "2024-01-01T00:00:00.000Z",
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      {
        id: "event-0-user-multimodal",
        role: "user",
        content: [
          { type: "text", text: "この画像を見て" },
          { type: "image", source: { type: "data", value: B64, mimeType: "image/png" } },
        ],
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("omits createdAt when eventTimestamp is missing or unparseable (additive/optional)", () => {
    const parsedEvents = [
      { role: "user" as const, content: [{ text: "no ts" }] },
      { role: "assistant" as const, content: [{ text: "bad ts" }], eventTimestamp: "not-a-date" },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      { id: "event-0-text-0", role: "user", content: "no ts" },
      { id: "event-1-text-0", role: "assistant", content: "bad ts" },
    ]);
    expect(messages.every((m) => !("createdAt" in m))).toBe(true);
  });

  it("ignores content blocks with unexpected shapes without throwing", () => {
    const parsedEvents = [
      {
        role: "assistant" as const,
        content: [{ unknownBlockType: "something" }, { text: "valid text" }],
      },
    ];

    expect(() => convertMemoryEventsToAGUIMessages(parsedEvents)).not.toThrow();
    expect(convertMemoryEventsToAGUIMessages(parsedEvents)).toEqual([
      { id: "event-0-text-1", role: "assistant", content: "valid text" },
    ]);
  });

  it("restores a text+image user turn as ONE user message with structured multimodal content (send-time shape)", () => {
    // Stored image block shape (verified against Strands + AgentCore Memory):
    // Strands Converse `{ image: { format, source: { bytes } } }`, with bytes
    // base64-encoded by SessionMessage.to_dict() as
    // `{ __bytes_encoded__: true, data: "<base64>" }` before json.dumps.
    const B64 = "aGVsbG8="; // "hello"
    const parsedEvents = [
      {
        role: "user" as const,
        content: [
          { text: "この画像を見て" },
          {
            image: {
              format: "png",
              source: { bytes: { __bytes_encoded__: true, data: B64 } },
            },
          },
        ],
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      {
        id: "event-0-user-multimodal",
        role: "user",
        content: [
          { type: "text", text: "この画像を見て" },
          { type: "image", source: { type: "data", value: B64, mimeType: "image/png" } },
        ],
      },
    ]);
  });

  it("restores an image-only user turn as ONE user message with a single image block", () => {
    const B64 = "d29ybGQ="; // "world"
    const parsedEvents = [
      {
        role: "user" as const,
        content: [
          {
            image: {
              format: "jpeg",
              source: { bytes: { __bytes_encoded__: true, data: B64 } },
            },
          },
        ],
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      {
        id: "event-0-user-multimodal",
        role: "user",
        content: [
          { type: "image", source: { type: "data", value: B64, mimeType: "image/jpeg" } },
        ],
      },
    ]);
  });

  it("falls back to a placeholder text block when an image block's base64 cannot be extracted (turn never vanishes)", () => {
    const parsedEvents = [
      {
        role: "user" as const,
        content: [{ image: { format: "png", source: {} } }],
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      {
        id: "event-0-user-multimodal",
        role: "user",
        content: [{ type: "text", text: "🖼 画像" }],
      },
    ]);
  });

  it("also accepts a plain base64 string in source.bytes (forward/alt-path compatibility)", () => {
    const B64 = "YWJj"; // "abc"
    const parsedEvents = [
      {
        role: "user" as const,
        content: [{ image: { format: "webp", source: { bytes: B64 } } }],
      },
    ];

    const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(messages).toEqual([
      {
        id: "event-0-user-multimodal",
        role: "user",
        content: [
          { type: "image", source: { type: "data", value: B64, mimeType: "image/webp" } },
        ],
      },
    ]);
  });

  it("produces identical output for repeated calls with the same input (deterministic ids)", () => {
    const parsedEvents = [
      { role: "user" as const, content: [{ text: "hello" }] },
      {
        role: "assistant" as const,
        content: [{ toolUse: { toolUseId: "tu-x", name: "toolX", input: {} } }],
      },
    ];

    const first = convertMemoryEventsToAGUIMessages(parsedEvents);
    const second = convertMemoryEventsToAGUIMessages(parsedEvents);

    expect(first).toEqual(second);
  });
});
