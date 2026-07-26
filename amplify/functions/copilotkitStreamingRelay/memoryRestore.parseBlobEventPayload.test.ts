/**
 * Unit tests for the blob-payload decode path (`parseBlobEventPayload` /
 * `parseEventPayload`) added to restore turns whose serialized JSON exceeds
 * AgentCore Memory's conversational text limit (`CONVERSATIONAL_MAX_SIZE =
 * 100000` chars). Any turn carrying a non-tiny image easily exceeds this
 * limit and is stored as a `blob` payload event instead of `conversational`;
 * the previous restore pipeline read only `conversational` payloads and
 * silently dropped these blob events, so a text+image user turn vanished
 * entirely (both text and image).
 *
 * Fixtures mirror the Python reference `AgentCoreMemoryConverter` (see
 * `bedrock_agentcore/memory/integrations/strands/bedrock_converter.py` and
 * `session_manager.py`): a message-carrying blob is stored as
 * `json.dumps(messages[0])` where `messages[0]` is the 2-element tuple
 * `(json.dumps(session_dict), role)`. So the decoded blob is a 2-element array
 * `[messageJsonStr, role]` where `messageJsonStr` is the JSON string of the
 * session dict `{ message: { role, content }, ... }`. Agent/session internal
 * state blobs are objects (`json.dumps(session.to_dict())`) → ignored.
 *
 * The `@aws-sdk/client-bedrock-agentcore` SDK types `payload[].blob` as
 * `PayloadType.BlobMember.blob: __DocumentType` (`@smithy/types` `DocumentType`
 * = `null | boolean | number | string | DocumentType[] | {...}`), i.e. an
 * untyped JSON value (NOT `Uint8Array`). The runtime value can therefore be an
 * already-parsed array or a raw JSON string, so both are exercised here.
 *
 * Requirements: 2.2, 2.7
 */

import {
  parseBlobEventPayload,
  parseEventPayload,
  convertMemoryEventsToAGUIMessages,
  type MemoryEvent,
} from "./memoryRestore";

// Build the session dict exactly as Strands' SessionMessage.to_dict() would
// (message + surrounding SessionMessage fields), then wrap it as the blob
// payload `[messageJsonStr, role]` produced by message_to_payload +
// json.dumps(messages[0]).
function sessionDict(role: "user" | "assistant", content: unknown[]): Record<string, unknown> {
  return {
    message: { role, content },
    message_id: 0,
    redact_message: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}

function blobArray(role: "user" | "assistant", content: unknown[]): [string, string] {
  return [JSON.stringify(sessionDict(role, content)), role];
}

function blobEvent(blob: unknown, eventId = "0000001756147154000#aaaa0001"): MemoryEvent {
  return {
    eventId,
    eventTimestamp: "2024-01-01T00:00:00.000Z",
    payload: [{ blob }],
  };
}

describe("parseBlobEventPayload / parseEventPayload — blob-carried conversational messages", () => {
  it("decodes a blob whose payload is an already-parsed 2-element array [messageJsonStr, role] into a conversational message", () => {
    const content = [
      { text: "この画像を見て" },
      { image: { format: "png", source: { bytes: { __bytes_encoded__: true, data: "aGVsbG8=" } } } },
    ];
    const event = blobEvent(blobArray("user", content));

    expect(parseBlobEventPayload(event)).toEqual({ role: "user", content });
    // parseEventPayload must dispatch blob events to the same decode path.
    expect(parseEventPayload(event)).toEqual({ role: "user", content });
  });

  it("decodes a blob delivered as a raw JSON string (SDK DocumentType may be a string) equivalently", () => {
    const content = [{ text: "hello" }];
    const event = blobEvent(JSON.stringify(blobArray("assistant", content)));

    expect(parseBlobEventPayload(event)).toEqual({ role: "assistant", content });
  });

  it("ignores an agent/session-state blob object (json.dumps(session.to_dict())) → null", () => {
    // Not a 2-element array → not a conversational message.
    expect(parseBlobEventPayload(blobEvent({ agentState: { foo: "bar" } }))).toBeNull();
    // Same, delivered as a JSON string.
    expect(parseBlobEventPayload(blobEvent(JSON.stringify({ agentState: 1 })))).toBeNull();
  });

  it("ignores a non-2-element array blob → null", () => {
    expect(parseBlobEventPayload(blobEvent(["only-one-element"]))).toBeNull();
    expect(parseBlobEventPayload(blobEvent([JSON.stringify(sessionDict("user", [])), "user", "extra"]))).toBeNull();
  });

  it("ignores a blob whose element[0] is not a string → null", () => {
    expect(parseBlobEventPayload(blobEvent([{ message: { role: "user", content: [] } }, "user"]))).toBeNull();
  });

  it("returns null (never throws) for malformed JSON string blobs", () => {
    expect(parseBlobEventPayload(blobEvent("{not valid json"))).toBeNull();
    expect(parseBlobEventPayload(blobEvent(["{also not valid json", "user"]))).toBeNull();
  });

  it("returns null for a role that is neither user nor assistant, or non-array content", () => {
    expect(parseBlobEventPayload(blobEvent(blobArray("user", "not-an-array" as unknown as unknown[])))).toBeNull();
    const badRole: [string, string] = [
      JSON.stringify({ message: { role: "system", content: [{ text: "x" }] } }),
      "system",
    ];
    expect(parseBlobEventPayload(blobEvent(badRole))).toBeNull();
  });

  it("parseEventPayload returns null for a blob that is not a conversational message", () => {
    expect(parseEventPayload(blobEvent({ agentState: 1 }))).toBeNull();
  });

  it("restores a blob-stored text+image user turn as ONE user multimodal AGUIMessage (text + image value/mimeType)", () => {
    // End-to-end: blob decode → convert. This is the exact scenario that used
    // to vanish (oversized turn stored as blob).
    const B64 = "aGVsbG8="; // "hello"
    const event = blobEvent(
      blobArray("user", [
        { text: "この画像を見て" },
        { image: { format: "png", source: { bytes: { __bytes_encoded__: true, data: B64 } } } },
      ])
    );

    const parsed = parseEventPayload(event);
    expect(parsed).not.toBeNull();

    const messages = convertMemoryEventsToAGUIMessages([parsed!]);

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

  it("returns null for a conversational (non-blob) event so parseBlobEventPayload only handles blob payloads", () => {
    const conversationalEvent: MemoryEvent = {
      eventId: "e-conv",
      eventTimestamp: "2024-01-01T00:00:00.000Z",
      payload: [
        {
          conversational: {
            role: "user",
            content: { text: JSON.stringify({ message: { role: "user", content: [{ text: "hi" }] } }) },
          },
        },
      ],
    };
    expect(parseBlobEventPayload(conversationalEvent)).toBeNull();
    // parseEventPayload still routes conversational events correctly.
    expect(parseEventPayload(conversationalEvent)).toEqual({ role: "user", content: [{ text: "hi" }] });
  });
});
