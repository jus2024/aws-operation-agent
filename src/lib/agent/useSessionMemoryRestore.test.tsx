/**
 * useSessionMemoryRestore のテスト
 *
 * - 純粋関数（`buildMemoryRestoreUrl`/`mapAGUIMessageToClientMessage`）は
 *   通常のユニットテストで検証する。
 * - フック本体の「`activeSessionId` 変更時に Memory 読み出し API が
 *   1回だけ呼び出されること」は `react-test-renderer` の `act()` で
 *   フックをレンダリングして検証する（この検証観点は実際にフックを
 *   レンダリングして副作用の発火回数を数える必要があり、純粋関数の
 *   ユニットテストだけでは代替できないため、軽量な `react-test-renderer`
 *   を devDependency として追加した）。
 * - `@copilotkit/react-core/v2` の `useAgent` は `CopilotKit` プロバイダーへの
 *   依存を持つため、`vi.mock` でモック化し、`agent.setMessages` の呼び出しを
 *   スパイとして観測する。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, create } from "react-test-renderer";
import {
  useSessionMemoryRestore,
  buildMemoryRestoreUrl,
  mapAGUIMessageToClientMessage,
} from "./useSessionMemoryRestore";

const { setMessagesMock, fetchAuthSessionMock, mockAgent } = vi.hoisted(() => {
  const setMessagesMock = vi.fn();
  return {
    setMessagesMock,
    fetchAuthSessionMock: vi.fn(),
    // `useAgent` はレンダーごとに呼ばれるため、モックが毎回新しい `agent`
    // オブジェクトを返すと `agent` を依存配列に含む `useEffect` が
    // 無限に再発火してしまう（実際の `useAgent` は同一の agent インスタンスを
    // 安定して返す）。テストでも安定した参照を返すよう、モジュール読み込み時に
    // 一度だけ生成したオブジェクトを使い回す。
    mockAgent: { setMessages: setMessagesMock },
  };
});

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mockAgent }),
  UseAgentUpdate: { OnMessagesChanged: "OnMessagesChanged" },
}));

vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: fetchAuthSessionMock,
}));

describe("buildMemoryRestoreUrl", () => {
  it("末尾スラッシュ付きの Function URL に対して正しく1つのスラッシュで連結する", () => {
    const url = buildMemoryRestoreUrl(
      "https://xxxx.lambda-url.us-west-2.on.aws/",
      "session-123",
    );
    expect(url).toBe(
      "https://xxxx.lambda-url.us-west-2.on.aws/memory/events?sessionId=session-123",
    );
  });

  it("末尾スラッシュがない Function URL でも二重/欠落なく連結する", () => {
    const url = buildMemoryRestoreUrl(
      "https://xxxx.lambda-url.us-west-2.on.aws",
      "session-123",
    );
    expect(url).toBe(
      "https://xxxx.lambda-url.us-west-2.on.aws/memory/events?sessionId=session-123",
    );
  });

  it("sessionId を URL エンコードする", () => {
    const url = buildMemoryRestoreUrl(
      "https://example.com/",
      "session with space",
    );
    expect(url).toContain("sessionId=session+with+space");
  });

  it("nextToken が指定された場合はクエリパラメータに含める", () => {
    const url = buildMemoryRestoreUrl(
      "https://example.com/",
      "session-1",
      "token-abc",
    );
    expect(url).toBe(
      "https://example.com/memory/events?sessionId=session-1&nextToken=token-abc",
    );
  });
});

describe("mapAGUIMessageToClientMessage", () => {
  it("テキストメッセージ（user）をそのまま変換する", () => {
    const result = mapAGUIMessageToClientMessage({
      id: "m1",
      role: "user",
      content: "こんにちは",
    });
    expect(result).toEqual({ id: "m1", role: "user", content: "こんにちは" });
  });

  it("テキストメッセージ（assistant）をそのまま変換する", () => {
    const result = mapAGUIMessageToClientMessage({
      id: "m2",
      role: "assistant",
      content: "はい、承知しました",
    });
    expect(result).toEqual({
      id: "m2",
      role: "assistant",
      content: "はい、承知しました",
    });
  });

  it("tool call メッセージを toolCalls 配列を持つ assistant メッセージに変換する", () => {
    const result = mapAGUIMessageToClientMessage({
      id: "toolcall-1",
      role: "assistant",
      toolCallId: "tool-1",
      toolCallName: "search",
      toolCallArgs: { query: "test" },
    });
    expect(result).toEqual({
      id: "toolcall-1",
      role: "assistant",
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: {
            name: "search",
            arguments: JSON.stringify({ query: "test" }),
          },
        },
      ],
    });
  });

  it("tool result メッセージを role: tool のメッセージに変換する", () => {
    const result = mapAGUIMessageToClientMessage({
      id: "toolresult-1",
      role: "tool",
      toolCallId: "tool-1",
      content: "検索結果です",
    });
    expect(result).toEqual({
      id: "toolresult-1",
      role: "tool",
      toolCallId: "tool-1",
      content: "検索結果です",
    });
  });
});

function TestHarness({ activeSessionId }: { activeSessionId: string | null }) {
  useSessionMemoryRestore({ activeSessionId });
  return null;
}

describe("useSessionMemoryRestore（フック本体）", () => {
  const originalFetch = global.fetch;
  const originalRelayUrl = process.env.NEXT_PUBLIC_COPILOTKIT_RELAY_URL;

  beforeEach(() => {
    setMessagesMock.mockClear();
    fetchAuthSessionMock.mockReset();
    fetchAuthSessionMock.mockResolvedValue({
      tokens: { accessToken: { toString: () => "test-token" } },
    });
    process.env.NEXT_PUBLIC_COPILOTKIT_RELAY_URL = "https://example.com/";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_COPILOTKIT_RELAY_URL = originalRelayUrl;
  });

  it("activeSessionId 変更時に Memory 読み出し API が1回だけ呼び出される", async () => {
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<TestHarness activeSessionId="session-a" />);
    });
    // マウント時の初回フェッチが解決するまで待つ
    await act(async () => {});

    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      root!.update(<TestHarness activeSessionId="session-b" />);
    });
    await act(async () => {});

    expect(global.fetch).toHaveBeenCalledTimes(2);

    // 同じ activeSessionId のまま再レンダリングしても再フェッチしない
    await act(async () => {
      root!.update(<TestHarness activeSessionId="session-b" />);
    });
    await act(async () => {});

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("取得したメッセージ0件でも agent.setMessages([]) を呼ぶ（空セッションのクリア）", async () => {
    await act(async () => {
      create(<TestHarness activeSessionId="session-empty" />);
    });
    await act(async () => {});

    expect(setMessagesMock).toHaveBeenCalledWith([]);
  });

  it("取得失敗時は agent.setMessages を呼ばない", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "boom" }),
    }) as unknown as typeof fetch;

    await act(async () => {
      create(<TestHarness activeSessionId="session-error" />);
    });
    await act(async () => {});

    expect(setMessagesMock).not.toHaveBeenCalled();
  });
});
