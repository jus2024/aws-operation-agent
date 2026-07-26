/**
 * useSessionSubmitHandler のテスト
 *
 * `onSubmitMessage`（`@copilotkit/react-ui` の `CopilotChat` から中継される、
 * ユーザーの送信テキストを受け取るコールバック）が呼ばれたときに、
 *   (a) セッション名自動生成（useSessionNameAutoGeneration 経由の renameSession）と
 *   (b) セッションの updatedAt 更新（touchSession）
 * の両方が発火することを検証する。いずれも DynamoDB `ChatSession` メタデータ更新
 * のみで、AgentCore Memory への読み書きには一切関与しない。
 *
 * `useSessionNameAutoGeneration.test.tsx` と同様に `react-test-renderer` を使い、
 * フックをレンダリングして副作用を検証する。
 *
 * Requirements: 1.2, 1.3
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, create } from "react-test-renderer";
import { useSessionSubmitHandler } from "./useSessionSubmitHandler";
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
  touchSession,
  onReady,
}: {
  activeSessionId: string | null;
  renameSession: (id: string, name: string) => Promise<unknown>;
  touchSession: (id: string) => Promise<void>;
  onReady: (handler: (messageText: string) => Promise<void>) => void;
}) {
  const { handleSubmitMessage } = useSessionSubmitHandler({
    activeSessionId,
    renameSession,
    touchSession,
  });
  onReady(handleSubmitMessage);
  return null;
}

describe("useSessionSubmitHandler", () => {
  beforeEach(() => {
    getMock.mockReset();
    generateClientMock.mockClear();
  });

  it("送信時に touchSession が activeSessionId で呼ばれる（毎回の updatedAt 更新）", async () => {
    // セッション名は変更済み → 命名は書き込まないが touch は毎回行う
    getMock.mockResolvedValue({ data: { sessionName: "手動でリネーム済みの名前" } });
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    const touchSession = vi.fn().mockResolvedValue(undefined);
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId="session-1"
          renameSession={renameSession}
          touchSession={touchSession}
          onReady={(h) => {
            handler = h;
          }}
        />,
      );
    });

    await act(async () => {
      await handler("2件目以降のメッセージ");
    });

    // 命名は書き込まない（既にデフォルト名から変更済み）
    expect(renameSession).not.toHaveBeenCalled();
    // touch は毎回発火する
    expect(touchSession).toHaveBeenCalledWith("session-1");
    expect(touchSession).toHaveBeenCalledTimes(1);
  });

  it("初回メッセージ送信時は命名と touch の両方が発火する", async () => {
    getMock.mockResolvedValue({ data: { sessionName: DEFAULT_SESSION_NAME } });
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    const touchSession = vi.fn().mockResolvedValue(undefined);
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId="session-2"
          renameSession={renameSession}
          touchSession={touchSession}
          onReady={(h) => {
            handler = h;
          }}
        />,
      );
    });

    await act(async () => {
      await handler("AWS Lambda の料金について教えて");
    });

    expect(renameSession).toHaveBeenCalledWith(
      "session-2",
      "AWS Lambda の料金について教えて",
    );
    expect(touchSession).toHaveBeenCalledWith("session-2");
  });

  it("activeSessionId が null の場合、touchSession も命名も呼ばない", async () => {
    const renameSession = vi.fn().mockResolvedValue({ data: null, error: null });
    const touchSession = vi.fn().mockResolvedValue(undefined);
    let handler: (messageText: string) => Promise<void> = async () => {};

    await act(async () => {
      create(
        <TestHarness
          activeSessionId={null}
          renameSession={renameSession}
          touchSession={touchSession}
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
    expect(touchSession).not.toHaveBeenCalled();
  });
});
