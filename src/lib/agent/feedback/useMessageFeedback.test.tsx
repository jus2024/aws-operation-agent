/**
 * useMessageFeedback の永続化失敗時ロールバックのテスト（Task 6.5）
 *
 * `generateClient<Schema>()`（`aws-amplify/data`）をモックし、Amplify Data の
 * create / update / delete が失敗した場合に、楽観的更新を最後に永続化成功した
 * 状態へロールバックし、エラーを表面化することを検証する（Req 2.7）。あわせて
 * (owner, messageId) upsert の create/update/delete 経路（Req 4.5, 4.6）と、
 * 未認証時に記録しない挙動（Req 4.7）を確認する。
 *
 * `useSessionNameAutoGeneration.test.tsx` と同様に `react-test-renderer` で
 * フックをレンダリングし、`vi.hoisted` + `vi.mock` で Amplify クライアントを
 * 差し替える。
 *
 * Requirements: 2.6, 2.7, 3.1, 3.2, 3.3, 3.4
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, create } from "react-test-renderer";
import {
  useMessageFeedback,
  type UseMessageFeedbackResult,
} from "./useMessageFeedback";

const { createMock, updateMock, deleteMock, generateClientMock } = vi.hoisted(
  () => {
    const createMock = vi.fn();
    const updateMock = vi.fn();
    const deleteMock = vi.fn();
    const generateClientMock = vi.fn(() => ({
      models: {
        MessageFeedback: {
          create: createMock,
          update: updateMock,
          delete: deleteMock,
        },
      },
    }));
    return { createMock, updateMock, deleteMock, generateClientMock };
  },
);

vi.mock("aws-amplify/data", () => ({
  generateClient: generateClientMock,
}));

function TestHarness({
  ownerUserId,
  onReady,
}: {
  ownerUserId: string | null;
  onReady: (result: UseMessageFeedbackResult) => void;
}) {
  const result = useMessageFeedback(ownerUserId);
  onReady(result);
  return null;
}

/** 最新のフック結果を取得できるハーネスを描画する。 */
function renderHook(ownerUserId: string | null) {
  const ref: { current: UseMessageFeedbackResult | null } = { current: null };
  act(() => {
    create(
      <TestHarness
        ownerUserId={ownerUserId}
        onReady={(r) => {
          ref.current = r;
        }}
      />,
    );
  });
  return {
    get result(): UseMessageFeedbackResult {
      if (!ref.current) throw new Error("hook not ready");
      return ref.current;
    },
  };
}

describe("useMessageFeedback の永続化とロールバック", () => {
  beforeEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();
    generateClientMock.mockClear();
  });

  it("create 成功時は楽観的更新をそのまま維持し永続化する（Req 4.5）", async () => {
    createMock.mockResolvedValue({
      data: { id: "rec-1" },
      errors: undefined,
    });
    const hook = renderHook("user-1");

    let outcome: { ok: boolean } = { ok: false };
    await act(async () => {
      outcome = await hook.result.recordFeedback("msg-1", "session-1", "good");
    });

    expect(outcome.ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(hook.result.getFeedback("msg-1")).toEqual({
      sentiment: "good",
      comment: null,
    });
    expect(hook.result.error).toBeNull();
  });

  it("create が例外を投げた場合、none 状態へロールバックしエラーを表示する（Req 2.7）", async () => {
    createMock.mockRejectedValue(new Error("network error"));
    const hook = renderHook("user-1");

    let outcome: { ok: boolean } = { ok: true };
    await act(async () => {
      outcome = await hook.result.recordFeedback("msg-1", "session-1", "good");
    });

    expect(outcome.ok).toBe(false);
    // 楽観的に good へ更新したが、失敗により none へロールバック
    expect(hook.result.getFeedback("msg-1")).toEqual({
      sentiment: null,
      comment: null,
    });
    expect(hook.result.error).toBe("network error");
    expect(hook.result.pendingMessageId).toBeNull();
  });

  it("create が errors を返した場合もロールバックしエラーを表示する（Req 2.7）", async () => {
    createMock.mockResolvedValue({
      data: null,
      errors: [{ message: "認可エラー" }],
    });
    const hook = renderHook("user-1");

    let outcome: { ok: boolean } = { ok: true };
    await act(async () => {
      outcome = await hook.result.recordFeedback("msg-1", "session-1", "bad");
    });

    expect(outcome.ok).toBe(false);
    expect(hook.result.getFeedback("msg-1")).toEqual({
      sentiment: null,
      comment: null,
    });
    expect(hook.result.error).toBe("認可エラー");
  });

  it("永続化成功後に update が失敗した場合、直前に成功した状態へロールバックする（Req 2.7, 4.6）", async () => {
    // 1 回目（good）は成功して永続化される
    createMock.mockResolvedValue({ data: { id: "rec-1" }, errors: undefined });
    // 2 回目（good → bad の更新）は失敗する
    updateMock.mockRejectedValue(new Error("update failed"));
    const hook = renderHook("user-1");

    await act(async () => {
      await hook.result.recordFeedback("msg-1", "session-1", "good");
    });
    expect(hook.result.getFeedback("msg-1").sentiment).toBe("good");

    let outcome: { ok: boolean } = { ok: true };
    await act(async () => {
      outcome = await hook.result.recordFeedback("msg-1", "session-1", "bad");
    });

    expect(outcome.ok).toBe(false);
    expect(updateMock).toHaveBeenCalledTimes(1);
    // bad へ楽観更新したが失敗 → 最後に永続化成功した good へ戻る
    expect(hook.result.getFeedback("msg-1")).toEqual({
      sentiment: "good",
      comment: null,
    });
    expect(hook.result.error).toBe("update failed");
  });

  it("同一 sentiment 再押下によるクリアは既存レコードを delete する（Req 4.6）", async () => {
    createMock.mockResolvedValue({ data: { id: "rec-1" }, errors: undefined });
    deleteMock.mockResolvedValue({ data: { id: "rec-1" }, errors: undefined });
    const hook = renderHook("user-1");

    await act(async () => {
      await hook.result.recordFeedback("msg-1", "session-1", "good");
    });

    let outcome: { ok: boolean } = { ok: false };
    await act(async () => {
      // 同じ good を再押下 → クリア（none）
      outcome = await hook.result.recordFeedback("msg-1", "session-1", "good");
    });

    expect(outcome.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith({ id: "rec-1" });
    expect(hook.result.getFeedback("msg-1")).toEqual({
      sentiment: null,
      comment: null,
    });
  });

  it("未認証（ownerUserId=null）のときは記録せずエラーを返す（Req 4.7）", async () => {
    const hook = renderHook(null);

    let outcome: { ok: boolean } = { ok: true };
    await act(async () => {
      outcome = await hook.result.recordFeedback("msg-1", "session-1", "good");
    });

    expect(outcome.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
    expect(hook.result.error).toBeTruthy();
  });
});
