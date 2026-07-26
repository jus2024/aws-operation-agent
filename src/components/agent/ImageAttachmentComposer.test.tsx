// @vitest-environment jsdom

/**
 * ImageAttachmentComposer のユニットテスト（Task 11.5）
 *
 * 本コンポーネントは `document` の paste リスナー・`<input type="file">`・
 * `URL.createObjectURL` によるサムネイル生成など実 DOM に依存するため、
 * フック用の `react-test-renderer`（node 環境）ではなく jsdom + Testing Library
 * で検証する（`@vitest-environment jsdom`）。
 *
 * 検証観点（代表例のみ。バリデーションの網羅は Property 9 の PBT に委譲）:
 *   - ファイル選択の accept 属性（PNG/JPEG/WebP/GIF, multiple）（Req 9.1）
 *   - テキスト入力フォーカス中の paste で画像添付・非フォーカス時は無視（Req 9.2）
 *   - サムネ + ファイル名 + サイズのプレビューと項目ごとの削除（Req 9.3）
 *   - 非ブロッキングなバリデーションメッセージ表示（型/サイズ/合計予算/枚数）（Req 9.8）
 *   - 添付/削除コントロールのキーボード操作 + aria-label（Req 9.9/9.10）
 *
 * 送信時 base64 化・転送量見積り（encode_failed / payload_too_large）は送信配線
 * （Task 11.4）の責務のため、本テストのスコープ外とする。
 *
 * Requirements: 9.1, 9.2, 9.3, 9.8, 9.9
 */

import React, { useState } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  act,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ImageAttachmentComposer,
  type PendingImageAttachment,
} from "./ImageAttachmentComposer";
import { IMAGE_MAX_BYTES } from "@/src/lib/agent/attachments/imageAttachment";

const MB = 1024 * 1024;

// --- テストユーティリティ ---------------------------------------------------

/**
 * 指定サイズ・MIME の `File` を生成する。大きなバッファを確保せずに
 * `size` を上書きし、境界値（3MB / 3MB+1）を安価に表現する。
 */
function makeFile(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

/** File 配列を FileList 風の array-like に変換する（`<input>.files` 用）。 */
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

/** 隠しファイル入力へ選択ファイルをセットして change を発火する。 */
function selectFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", {
    value: toFileList(files),
    configurable: true,
  });
  fireEvent.change(input);
}

/** クリップボード画像の paste イベントを document に配送する。 */
function dispatchPaste(files: File[]): void {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as Event & { clipboardData: unknown };
  event.clipboardData = { files: toFileList(files) };
  act(() => {
    document.dispatchEvent(event);
  });
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input as HTMLInputElement;
}

/**
 * controlled な Composer を state 付きでラップするテストハーネス。
 * 併置した textarea はフォーカス依存の paste 挙動を検証するために置く。
 */
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [attachments, setAttachments] = useState<PendingImageAttachment[]>([]);
  return (
    <div>
      <textarea aria-label="メッセージ入力" defaultValue="" />
      <ImageAttachmentComposer
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        disabled={disabled}
      />
    </div>
  );
}

// jsdom は URL.createObjectURL/revokeObjectURL を実装しないためスタブする。
let urlCounter = 0;
beforeEach(() => {
  urlCounter = 0;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => `blob:mock-${urlCounter++}`,
  );
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- ファイル選択 (Req 9.1) --------------------------------------------------

describe("ファイル選択", () => {
  it("accept は PNG/JPEG/WebP/GIF に限定され multiple を許可する", () => {
    const { container } = render(<Harness />);
    const input = getFileInput(container);

    expect(input.getAttribute("accept")).toBe(
      "image/png,image/jpeg,image/webp,image/gif",
    );
    expect(input.multiple).toBe(true);
  });

  it("選択した画像がプレビューへ追加される", () => {
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("photo.png", "image/png", 2048),
    ]);

    expect(screen.getByAltText("photo.png のプレビュー")).toBeTruthy();
  });
});

// --- 貼り付け (Req 9.2) ------------------------------------------------------

describe("貼り付け", () => {
  it("テキスト入力フォーカス中の paste で画像が添付される", () => {
    render(<Harness />);
    const textInput = screen.getByLabelText("メッセージ入力") as HTMLTextAreaElement;
    textInput.focus();

    dispatchPaste([makeFile("pasted.png", "image/png", 1024)]);

    expect(screen.getByAltText("pasted.png のプレビュー")).toBeTruthy();
  });

  it("フォーカスが無い状態の paste は無視される", () => {
    render(<Harness />);
    // 何もフォーカスしない（activeElement は body）
    dispatchPaste([makeFile("ignored.png", "image/png", 1024)]);

    expect(screen.queryByAltText("ignored.png のプレビュー")).toBeNull();
  });
});

// --- プレビュー + 個別削除 (Req 9.3) -----------------------------------------

describe("プレビューと個別削除", () => {
  it("サムネ・ファイル名・サイズを表示する", () => {
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("chart.png", "image/png", 2048),
    ]);

    expect(screen.getByAltText("chart.png のプレビュー")).toBeTruthy();
    expect(screen.getByText("chart.png")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
  });

  it("削除ボタンで該当項目だけを取り除く", () => {
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("a.png", "image/png", 1024),
      makeFile("b.png", "image/png", 1024),
    ]);
    expect(screen.getByAltText("a.png のプレビュー")).toBeTruthy();
    expect(screen.getByAltText("b.png のプレビュー")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "a.png を削除" }));

    expect(screen.queryByAltText("a.png のプレビュー")).toBeNull();
    expect(screen.getByAltText("b.png のプレビュー")).toBeTruthy();
  });
});

// --- バリデーションメッセージ (Req 9.8) --------------------------------------

describe("バリデーションメッセージ（非ブロッキング）", () => {
  it("許可外の型を拒否理由付きで表示する", () => {
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("note.txt", "text/plain", 100),
    ]);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/対応していない画像形式/)).toBeTruthy();
    expect(screen.queryByAltText("note.txt のプレビュー")).toBeNull();
  });

  it("単一画像 3MB 超過を拒否する", () => {
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("big.png", "image/png", IMAGE_MAX_BYTES + 1),
    ]);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/1 枚あたり 3MB/)).toBeTruthy();
  });

  it("メッセージ合計 3MB 予算の超過を拒否し、収まる分は受理する", () => {
    const { container } = render(<Harness />);
    // 2MB + 2MB = 4MB → 1 枚目は受理、2 枚目は合計予算超過
    selectFiles(getFileInput(container), [
      makeFile("first.png", "image/png", 2 * MB),
      makeFile("second.png", "image/png", 2 * MB),
    ]);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/1 メッセージあたり 3MB/)).toBeTruthy();
    expect(screen.getByAltText("first.png のプレビュー")).toBeTruthy();
    expect(screen.queryByAltText("second.png のプレビュー")).toBeNull();
  });

  it("最大 3 枚を超える添付を拒否する", () => {
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("1.png", "image/png", 100),
      makeFile("2.png", "image/png", 100),
      makeFile("3.png", "image/png", 100),
      makeFile("4.png", "image/png", 100),
    ]);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/最大 3 枚/)).toBeTruthy();
    expect(screen.getByAltText("3.png のプレビュー")).toBeTruthy();
    expect(screen.queryByAltText("4.png のプレビュー")).toBeNull();
  });
});

// --- キーボード操作 / aria (Req 9.9/9.10) ------------------------------------

describe("キーボード操作とアクセシビリティ", () => {
  it("添付ボタンと削除ボタンに aria-label が付与される", () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole("button", { name: "画像を添付" })).toBeTruthy();

    selectFiles(getFileInput(container), [
      makeFile("doc.png", "image/png", 512),
    ]);
    expect(screen.getByRole("button", { name: "doc.png を削除" })).toBeTruthy();
  });

  it("削除ボタンをキーボード（Enter）で操作できる", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    selectFiles(getFileInput(container), [
      makeFile("kbd.png", "image/png", 512),
    ]);

    const removeButton = screen.getByRole("button", { name: "kbd.png を削除" });
    removeButton.focus();
    expect(document.activeElement).toBe(removeButton);

    await user.keyboard("{Enter}");

    expect(screen.queryByAltText("kbd.png のプレビュー")).toBeNull();
  });
});
