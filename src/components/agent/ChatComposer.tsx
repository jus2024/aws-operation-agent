"use client";

import "./chat-composer.css";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import type { InputProps } from "@copilotkit/react-ui";
import {
  ACCEPTED_IMAGE_TYPES,
  canAcceptMore,
  validateImageFile,
  withinMessageBudget,
  type ImageAttachmentError,
} from "@/src/lib/agent/attachments/imageAttachment";
import { useImageMessageSender } from "@/src/lib/agent/attachments/useImageMessageSender";
import type { SendImageMessageResult } from "@/src/lib/agent/attachments/useImageMessageSender";
import type { PendingImageAttachment } from "./ImageAttachmentComposer";
import { useChatComposerContext } from "./ChatComposerContext";

/**
 * ChatComposer — CopilotChat のカスタム入力コンポーネント（`Input` プロップ）
 *
 * mocks/chat.html の入力コンポーザ（角丸コンテナ内の添付ボタン・伸縮する
 * `<textarea>`・送信ボタン、上部に添付プレビュー帯、下部にヒント行）に準拠する。
 * 画像の添付・貼り付け・プレビュー・検証は既存の純粋バリデーション
 * （`imageAttachment.ts` の validateImageFile / canAcceptMore / withinMessageBudget）
 * に委譲し、送出は既存の送信配線（`useImageMessageSender`）に委譲する
 * （接続構成 /api/copilotkit + SigV4 は変更しない）。
 *
 * 送信の分岐（Req 9.6, 9.8, 9.9, 8.7）:
 *   - 添付あり: `useImageMessageSender.send(text, attachments)` で base64 インライン
 *     送出する。成功時はテキストと添付をクリアし、`onSend` をバイパスする経路のため
 *     セッション副作用（`ChatComposerContext.onUserSubmit`）を 1 回呼ぶ。失敗時は
 *     `role="alert"` で理由を表示し、添付は保持する（黙って落とさない）。
 *   - 添付なし: CopilotChat が渡す `onSend(text)` を呼ぶ（既定のテキスト送出経路。
 *     `onSubmitMessage` → セッション名自動生成/touchSession の配線を保つ）。
 *
 * `@copilotkit/react-core/v2` 経由の `useAgent` を内部で使う `useImageMessageSender`
 * を用いるため、本コンポーネントは `CopilotProvider`（CopilotKit）配下で描画すること。
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.8, 9.9, 9.10, 8.2, 8.7, 7.3
 */

/** CopilotProvider に登録されているエージェント ID（CopilotProvider.tsx の agent と一致）。 */
const AGENT_ID = "sample_agent";

/** 生バイト数を人間可読なサイズ文字列へ整形する（プレビュー表示用）。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 一意な添付 ID を生成する（crypto.randomUUID が使えない環境へのフォールバック付き）。 */
function generateAttachmentId(): string {
  const c: Crypto | undefined =
    typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 画像 MIME タイプかどうか（貼り付けデータの選別に使用）。 */
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** クリップボード貼り付けを受け付けるべきかを判定する（テキスト入力フォーカス中のみ）。 */
function isTextInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return type !== "file" && type !== "button" && type !== "submit";
  }
  return el.isContentEditable;
}

/** 拒否/送信失敗理由を非ブロッキングなメッセージへマップする（Req 9.4, 9.5, 9.8）。 */
function reasonMessage(
  reason: ImageAttachmentError | "agent_unavailable",
  filename?: string,
): string {
  const prefix = filename ? `${filename}: ` : "";
  switch (reason) {
    case "unsupported_type":
      return `${prefix}対応していない画像形式です（PNG / JPEG / WebP / GIF のみ添付できます）`;
    case "file_too_large":
      return `${prefix}画像サイズが上限（1 枚あたり 3MB）を超えています`;
    case "message_budget_exceeded":
      return "添付画像の合計サイズが上限（1 メッセージあたり 3MB）を超えるため追加できません";
    case "too_many":
      return "添付できる画像は最大 3 枚までです";
    case "encode_failed":
      return `${prefix}画像の読み込みに失敗しました`;
    case "payload_too_large":
      return "送信データが大きすぎるため送信できません。画像を減らすか小さくしてください";
    case "agent_unavailable":
      return "エージェントに接続できないため送信できません。しばらくして再度お試しください";
  }
}

export function ChatComposer({
  inProgress,
  onSend,
  onStop,
  hideStopButton = false,
  chatReady = true,
}: InputProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingImageAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { send } = useImageMessageSender(AGENT_ID);
  const { onUserSubmit } = useChatComposerContext();

  // 添付操作は送信中・生成中は無効化する。
  const busy = inProgress || sending;

  // object URL の追跡と revoke（削除/クリア/アンマウント時）。
  const knownUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(attachments.map((a) => a.previewUrl));
    knownUrlsRef.current.forEach((url) => {
      if (!current.has(url)) {
        URL.revokeObjectURL(url);
      }
    });
    knownUrlsRef.current = current;
  }, [attachments]);
  useEffect(
    () => () => {
      knownUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      knownUrlsRef.current = new Set();
    },
    [],
  );

  // textarea の自動リサイズ（内容に応じて高さを CSS の max-height まで伸縮）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  /**
   * 受け取ったファイル群を検証して受理分だけ添付へ加える（Req 9.4, 9.5）。
   * 検証は純粋関数へ委譲し、拒否は非ブロッキングにメッセージ表示する。
   */
  const addFiles = useCallback(
    (incoming: File[]) => {
      if (busy || incoming.length === 0) return;

      const accepted: PendingImageAttachment[] = [];
      const nextErrors: string[] = [];
      let runningSizes = attachments.map((a) => a.sizeBytes);
      let runningCount = attachments.length;

      for (const file of incoming) {
        const meta = {
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        };

        const fileResult = validateImageFile(meta);
        if (!fileResult.ok) {
          nextErrors.push(reasonMessage(fileResult.reason, file.name));
          continue;
        }

        const countResult = canAcceptMore(runningCount, 1);
        if (!countResult.ok) {
          nextErrors.push(reasonMessage(countResult.reason, file.name));
          continue;
        }

        const budgetResult = withinMessageBudget([...runningSizes, file.size]);
        if (!budgetResult.ok) {
          nextErrors.push(reasonMessage(budgetResult.reason, file.name));
          continue;
        }

        accepted.push({
          id: generateAttachmentId(),
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: URL.createObjectURL(file),
        });
        runningSizes = [...runningSizes, file.size];
        runningCount += 1;
      }

      if (accepted.length > 0) {
        setAttachments((prev) => [...prev, ...accepted]);
      }
      setErrors(Array.from(new Set(nextErrors)));
    },
    [attachments, busy],
  );

  // テキスト入力フォーカス中の paste で画像を添付する（Req 9.2）。
  useEffect(() => {
    if (busy) return;
    const handlePaste = (e: ClipboardEvent) => {
      if (!isTextInputFocused()) return;
      const items = e.clipboardData?.files;
      if (!items || items.length === 0) return;
      const images = Array.from(items).filter(isImageFile);
      if (images.length === 0) return;
      e.preventDefault();
      addFiles(images);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [busy, addFiles]);

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      addFiles(Array.from(files));
    }
    // 同じファイルを続けて選択できるように value をリセットする。
    e.target.value = "";
  };

  const handleRemove = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const clearComposer = () => {
    setText("");
    setAttachments([]);
  };

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    const trimmed = text.trim();
    const hasAttachments = attachments.length > 0;
    // テキストも添付も無ければ送信しない。
    if (!trimmed && !hasAttachments) return;

    if (hasAttachments) {
      setErrors([]);
      setSending(true);
      let result: SendImageMessageResult;
      try {
        result = await send(
          text,
          attachments.map((a) => ({ contentType: a.contentType, file: a.file })),
        );
      } finally {
        setSending(false);
      }

      if (result.ok) {
        // 画像経路は onSend をバイパスするため、セッション副作用を明示的に発火する
        // （セッション名自動生成 + touchSession）。null-safe。
        try {
          await onUserSubmit?.(text);
        } catch {
          // セッション副作用の失敗は送信成功を妨げない（ベストエフォート）。
        }
        clearComposer();
      } else {
        // 失敗時は理由を表示し、添付は保持する（黙って落とさない）。
        setErrors([reasonMessage(result.reason)]);
      }
      return;
    }

    // テキストのみ: CopilotKit の onSend 経路（onSubmitMessage の配線を保つ）。
    setErrors([]);
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
    } catch {
      setErrors(["メッセージの送信に失敗しました。もう一度お試しください"]);
    } finally {
      setSending(false);
    }
  }, [busy, text, attachments, send, onSend, onUserSubmit]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter で送信、Shift+Enter で改行（IME 変換確定中は送信しない）。
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const acceptAttr = ACCEPTED_IMAGE_TYPES.join(",");
  const showStop = inProgress && !!onStop && !hideStopButton;
  const canSend =
    chatReady && !busy && (text.trim().length > 0 || attachments.length > 0);

  return (
    <div className="chat-composer">
      {/* 単一の中央寄せカラム: プレビュー帯・入力行・エラー・ヒントを同じ幅で束ねる。
          各要素が独立に max-width/margin:auto で中央寄せすると微妙にずれるため、
          プレビュー帯が入力行の直上に同じ左右幅でそろうよう 1 つのカラムに包む
          （Req 9.3 のプレビュー配置）。 */}
      <div className="chat-composer__col">
        {/* 添付画像プレビュー帯（入力行の上）（Req 9.3） */}
        {attachments.length > 0 && (
          <ul className="chat-composer__previews" aria-label="添付した画像">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="chat-composer__thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="chat-composer__thumb-img"
                src={attachment.previewUrl}
                alt={`${attachment.filename} のプレビュー`}
              />
              <button
                type="button"
                className="chat-composer__thumb-remove"
                onClick={() => handleRemove(attachment.id)}
                disabled={busy}
                aria-label={`${attachment.filename} を削除`}
                title="削除"
              >
                <span aria-hidden="true">×</span>
              </button>
              <div
                className="chat-composer__thumb-caption"
                title={`${attachment.filename} · ${formatFileSize(attachment.sizeBytes)}`}
              >
                {attachment.filename} · {formatFileSize(attachment.sizeBytes)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 入力行（角丸コンテナ）: 添付ボタン + textarea + 送信/停止ボタン */}
      <div className="chat-composer__inner">
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptAttr}
          multiple
          onChange={handleFileInputChange}
          disabled={busy}
          style={{ display: "none" }}
          aria-hidden="true"
          tabIndex={-1}
        />

        <button
          type="button"
          className="chat-composer__attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="画像を添付"
          title="画像を添付"
        >
          <svg
            className="chat-composer__attach-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          className="chat-composer__input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          placeholder="メッセージを入力…"
          aria-label="メッセージを入力"
        />

        {showStop ? (
          <button
            type="button"
            className="chat-composer__send chat-composer__send--stop"
            onClick={onStop}
            aria-label="生成を停止"
            title="停止"
          >
            <svg
              className="chat-composer__send-icon"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="chat-composer__send"
            onClick={() => void handleSubmit()}
            disabled={!canSend}
            aria-label="送信"
            title="送信"
          >
            <svg
              className="chat-composer__send-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* 非ブロッキングなバリデーション/送信エラー（Req 9.4, 9.5, 9.8） */}
      {errors.length > 0 && (
        <ul className="chat-composer__errors" role="alert">
          {errors.map((message, i) => (
            <li key={i} className="chat-composer__error">
              {message}
            </li>
          ))}
        </ul>
      )}

        {/* ヒント行（貼り付け操作 + 生成 AI の注意）（mock .composer__hint） */}
        <p className="chat-composer__hint">
          スクショは <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>V</kbd>{" "}
          で貼り付けできます。回答は生成 AI によるものです。重要な操作の前に内容をご確認ください。
        </p>
      </div>
    </div>
  );
}

export default ChatComposer;
