/**
 * useSessionNameAutoGeneration のテスト
 *
 * `onSubmitMessage`（`@copilotkit/react-ui` の `CopilotChat` から中継される、
 * ユーザーの送信テキストを受け取るコールバック）が呼ばれたときに、
 * DynamoDB の `ChatSession.sessionName` を自動生成する動作を検証する。
 * AgentCore Memory への読み書きには一切関与しないため、その点のテストは
 * 対象外（そもそも Memory 呼び出し用の依存を持たない）。
 *
 * `useSessionMemoryRestore.test.tsx` と同様に `react-test-renderer` を使い、
 * フックをレンダリングして副作用を検証する。
 *
 * Requirements: 1.2, 1.3
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, create } from "react-test-renderer";
import { useSessionNameAutoGeneration } from "./useSessionNameAutoGeneration";
import { DEFAULT_SESSION_NAME } from "./sessionNameResolver";

const { getMock, generateClientMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  const generateClientMock = vi.fn(() => ({
    models: {
      ChatSession: {
        get: getMock,
      },
    },
  }));
  return { getMock, generateClientMock };
});

vi.mock("aws-amplify/data", () => ({
  generateClient: generateClientMock,
}));

function TestHarness({
  activeSessionId,
  renameSession,
  onReady,
}: {
  activeSessionId: string | null;
  renameSession: (id: string, name: string) => Promise<unknown>;
  onReady: (handler: (messageText: string) => Promise<void>) => void;
}) {
  const { handleSubmitMessage } = useSessionNameAutoGeneration({
    activeSessionId,
    renameSession,
  });
  onReady(handleSubmitMessage);
  return null;
}

describe("useSessionNameAutoGeneration", () => {
  beforeEach(() => {
    getMock.mockReset();
    generateClientMock.mockClear();
  });

  it("セッション名がデフォルト名のままの場合、送信テキストから自動生成した名前で renameSession を呼ぶ", async () => {
    getMock.mockResolvedValue({ data: { sessionName: DEFAULT_SESSION_NAME } });
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId="session-1"
          renameSession={renameSession}
          onReady={(h) => {
            handler = h;
          }}
        />,
      );
    });

    await act(async () => {
      await handler("AWS Lambda の料金について教えて");
    });

    expect(getMock).toHaveBeenCalledWith({ id: "session-1" });
    expect(renameSession).toHaveBeenCalledWith(
      "session-1",
      "AWS Lambda の料金について教えて",
    );
  });

  it("セッション名が既にデフォルト名から変更済みの場合、renameSession を呼ばない", async () => {
    getMock.mockResolvedValue({ data: { sessionName: "手動でリネーム済みの名前" } });
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId="session-2"
          renameSession={renameSession}
          onReady={(h) => {
            handler = h;
          }}
        />,
      );
    });

    await act(async () => {
      await handler("2件目以降のメッセージ");
    });

    expect(renameSession).not.toHaveBeenCalled();
  });

  it("activeSessionId が null の場合、ChatSession.get も renameSession も呼ばない", async () => {
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId={null}
          renameSession={renameSession}
          onReady={(h) => {
            handler = h;
          }}
        />,
      );
    });

    await act(async () => {
      await handler("何かメッセージ");
    });

    expect(getMock).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("ChatSession.get が失敗した場合、例外を伝播させずベストエフォートで終了する", async () => {
    getMock.mockRejectedValue(new Error("network error"));
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId="session-3"
          renameSession={renameSession}
          onReady={(h) => {
            handler = h;
          }}
        />,
      );
    });

    await expect(
      act(async () => {
        await handler("エラーケース");
      }),
    ).resolves.not.toThrow();

    expect(renameSession).not.toHaveBeenCalled();
  });
});
