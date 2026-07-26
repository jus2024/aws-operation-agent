// @vitest-environment jsdom

/**
 * ChatComposer のユニットテスト
 *
 * ChatComposer は CopilotChat のカスタム Input として、テキストのみの送信を
 * CopilotKit の `onSend` に、画像付き送信を `useImageMessageSender`（内部で
 * `@copilotkit/react-core/v2` の `useAgent` を使用）に振り分ける。`useAgent` は
 * `CopilotKit` プロバイダーへの依存を持つため `vi.mock` でモック化し、フェイク
 * agent の `addMessage`/`runAgent`/`setMessages` をスパイして送出経路を検証する
 * （既存 `useImageMessageSender.test.tsx` と同じ方針）。
 *
 * 検証観点（代表例）:
 *   - 添付ボタン・textarea・送信ボタンを描画する
 *   - テキストのみの送信は注入された `onSend` を呼ぶ（画像経路は呼ばない）
 *   - 画像添付ありの送信は sender（addMessage/runAgent）を呼び `onSend` は呼ばない。
 *     さらに `onSend` をバイパスするためセッション副作用（onUserSubmit）を発火する
 *   - 送出失敗時は role="alert" を表示し、添付を保持する（黙って落とさない）
 *
 * バリデーションの網羅（型/サイズ/枚数/合計予算）は純粋関数（Property 9）と
 * ImageAttachmentComposer のテストに委譲し、ここでは分岐と配線のみを確認する。
 */

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
  waitFor,
} from "@testing-library/react";
import type { Message } from "@ag-ui/client";
import { ChatComposer } from "./ChatComposer";
import { ChatComposerProvider } from "./ChatComposerContext";

const { mockState, setMessagesMock, addMessageMock, runAgentMock } = vi.hoisted(
  () => {
    const setMessagesMock = vi.fn();
    const addMessageMock = vi.fn();
    const runAgentMock = vi.fn(() => Promise.resolve());
    return {
      setMessagesMock,
      addMessageMock,
      runAgentMock,
      mockState: {
        agent: {
          messages: [] as Message[],
          setMessages: setMessagesMock,
          addMessage: addMessageMock,
          runAgent: runAgentMock,
        } as unknown,
      },
    };
  },
);

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mockState.agent }),
  UseAgentUpdate: { OnMessagesChanged: "OnMessagesChanged" },
}));

// --- テストユーティリティ ---------------------------------------------------

function makeFile(name: string, type: string, content: string): File {
  return new File([content], name, { type });
}

function toFileList(files: File[]): FileList {
  const list: Record<string, unknown> = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  };
  files.forEach((f, i) => {
    list[i] = f;
  });
  return list as unknown as FileList;
}

function selectFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", {
    value: toFileList(files),
    configurable: true,
  });
  fireEvent.change(input);
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input as HTMLInputElement;
}

function makeOnSend() {
  return vi.fn(
    (text: string): Promise<Message> =>
      Promise.resolve({ id: "m1", role: "user", content: text } as unknown as Message),
  );
}

function renderComposer(opts: {
  onSend: ReturnType<typeof makeOnSend>;
  onUserSubmit?: (text: string) => void | Promise<void>;
  inProgress?: boolean;
}) {
  return render(
    <ChatComposerProvider value={{ onUserSubmit: opts.onUserSubmit }}>
      <ChatComposer
        inProgress={opts.inProgress ?? false}
        onSend={opts.onSend}
        chatReady
      />
    </ChatComposerProvider>,
  );
}

let urlCounter = 0;
beforeEach(() => {
  urlCounter = 0;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => `blob:mock-${urlCounter++}`,
  );
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  setMessagesMock.mockClear();
  addMessageMock.mockClear();
  runAgentMock.mockClear();
  mockState.agent = {
    messages: [],
    setMessages: setMessagesMock,
    addMessage: addMessageMock,
    runAgent: runAgentMock,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- 描画 --------------------------------------------------------------------

describe("描画", () => {
  it("添付ボタン・textarea・送信ボタンを描画する", () => {
    renderComposer({ onSend: makeOnSend() });
    expect(screen.getByRole("button", { name: "画像を添付" })).toBeTruthy();
    expect(screen.getByLabelText("メッセージを入力")).toBeTruthy();
    expect(screen.getByRole("button", { name: "送信" })).toBeTruthy();
  });
});

// --- テキストのみの送信 ------------------------------------------------------

describe("テキストのみの送信", () => {
  it("注入された onSend を呼び、画像送出経路（addMessage）は呼ばない", async () => {
    const onSend = makeOnSend();
    const onUserSubmit = vi.fn();
    renderComposer({ onSend, onUserSubmit });

    const textarea = screen.getByLabelText("メッセージを入力");
    fireEvent.change(textarea, { target: { value: "コスト内訳を教えて" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "送信" }));
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("コスト内訳を教えて");
    expect(addMessageMock).not.toHaveBeenCalled();
    // テキスト経路では onSubmitMessage が担うため onUserSubmit は呼ばない
    expect(onUserSubmit).not.toHaveBeenCalled();
    // 送信後にテキストがクリアされる
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("空入力では送信しない", () => {
    const onSend = makeOnSend();
    renderComposer({ onSend });
    // 送信ボタンは無効
    const sendButton = screen.getByRole("button", { name: "送信" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
  });
});

// --- 画像添付ありの送信 ------------------------------------------------------

describe("画像添付ありの送信", () => {
  it("sender（addMessage/runAgent）を呼び onSend は呼ばない。onUserSubmit を発火する", async () => {
    const onSend = makeOnSend();
    const onUserSubmit = vi.fn();
    const { container } = renderComposer({ onSend, onUserSubmit });

    selectFiles(getFileInput(container), [
      makeFile("shot.png", "image/png", "hello"),
    ]);
    // プレビューが表示される
    expect(screen.getByAltText("shot.png のプレビュー")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    // 送出は base64 化（FileReader, 非同期）を挟むため完了を待つ。
    await waitFor(() => expect(addMessageMock).toHaveBeenCalledTimes(1));
    const added = addMessageMock.mock.calls[0][0];
    expect(added.role).toBe("user");
    expect(added.content).toEqual([
      {
        type: "image",
        source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
      },
    ]);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    // 画像経路は onSend をバイパスする
    expect(onSend).not.toHaveBeenCalled();
    // セッション副作用が 1 回発火する
    await waitFor(() => expect(onUserSubmit).toHaveBeenCalledTimes(1));
    // 送信後に添付がクリアされる
    await waitFor(() =>
      expect(screen.queryByAltText("shot.png のプレビュー")).toBeNull(),
    );
  });

  it("送出失敗時は role=alert を表示し、添付を保持する（黙って落とさない）", async () => {
    // agent 不在で送出を失敗させる（agent_unavailable）。
    mockState.agent = null;
    const onSend = makeOnSend();
    const { container } = renderComposer({ onSend });

    selectFiles(getFileInput(container), [
      makeFile("keep.png", "image/png", "hello"),
    ]);
    expect(screen.getByAltText("keep.png のプレビュー")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    // 非ブロッキングなエラーを表示する（送出失敗は base64 化後に判定するため待つ）。
    await screen.findByRole("alert");
    // 添付は保持される
    expect(screen.getByAltText("keep.png のプレビュー")).toBeTruthy();
    // 送出（addMessage/runAgent）は行われない
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
