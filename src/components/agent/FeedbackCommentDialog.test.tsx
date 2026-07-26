// @vitest-environment jsdom

/**
 * FeedbackCommentDialog のユニットテスト（Task 6.5）
 *
 * 検証観点:
 *   - Bad 評価時に開く任意コメント入力ダイアログ（Req 3.1）
 *   - コメント有りで送信 → 前後空白を除いた非空コメントを onSubmit へ渡す（Req 3.3）
 *   - コメント無しで送信 → onSubmit へ undefined を渡す（Req 3.2）
 *   - キャンセル / オーバーレイクリック / Escape でコメント無しのまま閉じる（Req 3.4）
 *   - 1000 文字超過時は送信を防止しバリデーションメッセージを表示（Req 3.5）
 *
 * Requirements: 2.6, 2.7, 3.1, 3.2, 3.3, 3.4
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FeedbackCommentDialog } from "./FeedbackCommentDialog";
import { FEEDBACK_COMMENT_MAX } from "@/src/lib/agent/feedback/feedbackState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function getDialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("コメント") as HTMLTextAreaElement;
}

function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "送信" }) as HTMLButtonElement;
}

function getCancelButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "キャンセル" }) as HTMLButtonElement;
}

describe("FeedbackCommentDialog の表示（Req 3.1）", () => {
  it("isOpen=false のときは何も描画しない", () => {
    render(
      <FeedbackCommentDialog isOpen={false} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isOpen=true のときはモーダルダイアログを描画する", () => {
    render(
      <FeedbackCommentDialog isOpen onSubmit={() => {}} onCancel={() => {}} />,
    );
    const dialog = getDialog();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(getTextarea()).toBeTruthy();
  });
});

describe("FeedbackCommentDialog の送信（Req 3.2, 3.3）", () => {
  it("コメント有りで送信すると前後空白を除いた非空文字列を onSubmit へ渡す", () => {
    const onSubmit = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(getTextarea(), { target: { value: "  回答が不正確でした  " } });
    fireEvent.click(getSubmitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("回答が不正確でした");
  });

  it("コメント無し（空）で送信すると undefined を onSubmit へ渡す", () => {
    const onSubmit = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.click(getSubmitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(undefined);
  });

  it("空白のみのコメントは undefined として扱う", () => {
    const onSubmit = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(getTextarea(), { target: { value: "    " } });
    fireEvent.click(getSubmitButton());

    expect(onSubmit).toHaveBeenCalledWith(undefined);
  });
});

describe("FeedbackCommentDialog のキャンセル（Req 3.4）", () => {
  it("キャンセルボタンで onCancel を呼び onSubmit は呼ばない", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <FeedbackCommentDialog isOpen onSubmit={onSubmit} onCancel={onCancel} />,
    );

    fireEvent.click(getCancelButton());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Escape キーで onCancel を呼ぶ", () => {
    const onCancel = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={() => {}} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ダイアログ本体のクリックでは閉じない（オーバーレイのみで閉じる）", () => {
    const onCancel = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={() => {}} onCancel={onCancel} />);

    fireEvent.click(getDialog());

    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("FeedbackCommentDialog の文字数バリデーション（Req 3.5）", () => {
  it("上限ちょうど（1000 文字）は送信可能", () => {
    const onSubmit = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(getTextarea(), {
      target: { value: "あ".repeat(FEEDBACK_COMMENT_MAX) },
    });

    expect(getSubmitButton().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(getSubmitButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("1000 文字超過（1001 文字）は送信を防止しバリデーションメッセージを表示する", () => {
    const onSubmit = vi.fn();
    render(<FeedbackCommentDialog isOpen onSubmit={onSubmit} onCancel={() => {}} />);

    fireEvent.change(getTextarea(), {
      target: { value: "あ".repeat(FEEDBACK_COMMENT_MAX + 1) },
    });

    const submit = getSubmitButton();
    expect(submit.disabled).toBe(true);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(String(FEEDBACK_COMMENT_MAX));

    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
