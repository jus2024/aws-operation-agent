// @vitest-environment jsdom

/**
 * useImageMessageSender のテスト（Task 11.4）
 *
 * `@copilotkit/react-core/v2` の `useAgent` は `CopilotKit` プロバイダーへの依存を
 * 持つため `vi.mock` でモック化し、フェイク agent の `setMessages`/`addMessage`/
 * `runAgent` 呼び出しをスパイして送出配線を検証する。フック本体は
 * `react-test-renderer` の `act()` でレンダリングする（既存
 * `useSessionMemoryRestore.test.tsx` と同じ方針）。
 *
 * 検証観点:
 *   - 受理済み添付が multimodal メッセージ（text + base64 image blocks）として
 *     addMessage され runAgent される（Req 9.6, 8.7）
 *   - 送信直前に過去ターンの画像バイナリがスレッドから strip される（Req 9.9）
 *   - エンコード失敗/転送上限超過は理由付きで失敗を返し、addMessage/runAgent を
 *     呼ばない（添付を黙って落とさない）（Req 9.8）
 *
 * Requirements: 9.6, 9.8, 9.9, 8.7
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, create } from "react-test-renderer";
import type { Message } from "@ag-ui/client";
import { useImageMessageSender, type SendImageMessageResult } from "./useImageMessageSender";
import { EFFECTIVE_TRANSPORT_MAX_BYTES } from "./imageAttachment";

const { mockAgent, setMessagesMock, addMessageMock, runAgentMock } = vi.hoisted(
  () => {
    const setMessagesMock = vi.fn();
    const addMessageMock = vi.fn();
    const runAgentMock = vi.fn(() => Promise.resolve());
    return {
      setMessagesMock,
      addMessageMock,
      runAgentMock,
      mockAgent: {
        messages: [] as Message[],
        setMessages: setMessagesMock,
        addMessage: addMessageMock,
        runAgent: runAgentMock,
      },
    };
  },
);

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mockAgent }),
  UseAgentUpdate: { OnMessagesChanged: "OnMessagesChanged" },
}));

function makeFile(name: string, type: string, content: string): File {
  return new File([content], name, { type });
}

/** フックをレンダリングして `send` を取り出すヘルパー。 */
function renderSender(): { send: ReturnType<typeof useImageMessageSender>["send"] } {
  let captured: ReturnType<typeof useImageMessageSender> | null = null;
  function Probe() {
    captured = useImageMessageSender();
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  if (!captured) {
    throw new Error("useImageMessageSender did not render");
  }
  return { send: captured.send };
}

beforeEach(() => {
  setMessagesMock.mockClear();
  addMessageMock.mockClear();
  runAgentMock.mockClear();
  mockAgent.messages = [];
});

describe("useImageMessageSender.send", () => {
  it("受理済み添付を multimodal メッセージとして addMessage + runAgent する", async () => {
    const { send } = renderSender();

    let result: SendImageMessageResult | undefined;
    await act(async () => {
      result = await send("これは何?", [
        { contentType: "image/png", file: makeFile("a.png", "image/png", "hello") },
      ]);
    });

    expect(result).toEqual({ ok: true });
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const added = addMessageMock.mock.calls[0][0];
    expect(added.role).toBe("user");
    expect(added.content).toEqual([
      { type: "text", text: "これは何?" },
      {
        type: "image",
        source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
      },
    ]);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("送信前に過去ターンの画像バイナリをスレッドから strip する（Req 9.9）", async () => {
    mockAgent.messages = [
      {
        id: "prev",
        role: "user",
        content: [
          { type: "text", text: "前ターンの質問" },
          {
            type: "image",
            source: { type: "data", value: "OLDBASE64", mimeType: "image/png" },
          },
        ],
      },
    ] as unknown as Message[];

    const { send } = renderSender();
    await act(async () => {
      await send("次の質問", []);
    });

    expect(setMessagesMock).toHaveBeenCalledTimes(1);
    const strippedThread = setMessagesMock.mock.calls[0][0] as Message[];
    expect((strippedThread[0] as { content: unknown }).content).toBe("前ターンの質問");
    // strip 後に現在ターンのメッセージを追加している
    expect(addMessageMock).toHaveBeenCalledTimes(1);
  });

  it("エンコード失敗時は encode_failed を返し addMessage/runAgent を呼ばない", async () => {
    const { send } = renderSender();

    let result: SendImageMessageResult | undefined;
    await act(async () => {
      result = await send("x", [
        { contentType: "image/png", file: makeFile("empty.png", "image/png", "") },
      ]);
    });

    expect(result).toEqual({ ok: false, reason: "encode_failed" });
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("転送上限超過時は payload_too_large を返し送出しない（黙って落とさない）", async () => {
    const rawBytes = Math.ceil((EFFECTIVE_TRANSPORT_MAX_BYTES * 3) / 4) + 1024;
    const bigContent = "a".repeat(rawBytes);

    const { send } = renderSender();
    let result: SendImageMessageResult | undefined;
    await act(async () => {
      result = await send("", [
        { contentType: "image/png", file: makeFile("big.png", "image/png", bigContent) },
      ]);
    });

    expect(result).toEqual({ ok: false, reason: "payload_too_large" });
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
