"use client";

import "./image-attachment-composer.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACCEPTED_IMAGE_TYPES,
  canAcceptMore,
  validateImageFile,
  withinMessageBudget,
  type ImageAttachmentError,
} from "@/src/lib/agent/attachments/imageAttachment";

/**
 * ImageAttachmentComposer — Composer の画像添付パート（Requirement 9.1–9.5, 9.10）
 *
 * メッセージ送信前の入力領域（Composer）のうち、画像の添付・貼り付け・プレビュー・
 * 検証を担う小さく合成可能なコンポーネント（`amplify-frontend` ルール）。
 *
 *   - ファイル選択: `<input type="file" accept=PNG/JPEG/WebP/GIF multiple>` で
 *     1 個以上の画像を選択する（Req 9.1）。
 *   - 貼り付け: テキスト入力にフォーカスがある間の paste（Ctrl+V / Cmd+V）で
 *     クリップボードの画像を保留メッセージへ添付する（Req 9.2）。
 *   - プレビュー: 各添付をサムネイル + ファイル名 + サイズで表示し、項目ごとの
 *     削除を提供する（Req 9.3）。
 *   - 検証: 選択/貼り付け時に純粋関数 `validateImageFile` / `canAcceptMore` /
 *     `withinMessageBudget`（`src/lib/agent/attachments/imageAttachment.ts`）を
 *     呼び、型許可外・単一画像 3MB 超過・メッセージ合計 3MB 予算超過（主要ゲート）・
 *     3 枚超過を **非ブロッキング** に拒否表示する（Req 9.4, 9.5）。
 *   - アクセシビリティ: 添付コントロールと各削除コントロールをキーボード操作可能に
 *     し、`aria-label` を付与する（Req 9.10）。可視フォーカスは CSS の
 *     `:focus-visible` で提供する（Req 7.3）。
 *
 * 本コンポーネントは検証と状態表示・プレビューに徹する。base64 化・転送量見積り・
 * AG-UI/CopilotKit への送出は送信時配線（別タスク）が担う。受理済み添付は
 * `file`（`File`）を保持し、送信時に呼び出し側がエンコードできるようにする。
 *
 * 状態は呼び出し側が保持する（controlled）。送信後のクリアや送信可否判断を
 * 呼び出し側で行えるようにするため。
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.10
 */

/**
 * 送信前の保留画像添付。純粋ロジックの `ImageAttachment` にプレビュー表示と
 * 送信時エンコードのための `file` / `previewUrl` を加えたビュー用の型。
 */
export interface PendingImageAttachment {
  /** 一意な添付 ID（プレビューの key / 個別削除に使用） */
  id: string;
  filename: string;
  /** 例: "image/png" */
  contentType: string;
  sizeBytes: number;
  /** 送信時に base64 化する元ファイル */
  file: File;
  /** サムネイル表示用の object URL（アンマウント/削除時に revoke） */
  previewUrl: string;
}

export interface ImageAttachmentComposerProps {
  /** 現在の保留添付（controlled） */
  attachments: PendingImageAttachment[];
  /** 添付の追加/削除で呼ばれる。呼び出し側が状態を更新する */
  onAttachmentsChange: (next: PendingImageAttachment[]) => void;
  /** 送信中などで添付操作を一時的に無効化する場合に true */
  disabled?: boolean;
  /** 添付ボタンの aria-label。省略時は既定文言 */
  attachLabel?: string;
}

/** 拒否理由を非ブロッキングなバリデーションメッセージへマップする（Req 9.4, 9.5）。 */
function validationMessage(
  reason: ImageAttachmentError,
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
      return "送信データが大きすぎるため送信できません";
  }
}

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

/** クリップボード貼り付けを受け付けるべきかを判定する（テキスト入力フォーカス中のみ）。 */
function isTextInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // ファイル/ボタン系ではないテキスト系入力のみを対象とする
    return type !== "file" && type !== "button" && type !== "submit";
  }
  return el.isContentEditable;
}

/** 画像 MIME タイプかどうか（貼り付けデータの選別に使用）。 */
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function ImageAttachmentComposer({
  attachments,
  onAttachmentsChange,
  disabled = false,
  attachLabel = "画像を添付",
}: ImageAttachmentComposerProps) {
  const [errors, setErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 現在保持している object URL を追跡し、削除/アンマウント時に revoke する。
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

  /**
   * 受け取ったファイル群を検証して受理分だけ添付へ加える（Req 9.4, 9.5）。
   * 検証は 11.1 の純粋関数に委譲し、拒否は非ブロッキングにメッセージ表示する。
   */
  const addFiles = useCallback(
    (incoming: File[]) => {
      if (disabled || incoming.length === 0) return;

      const accepted: PendingImageAttachment[] = [];
      const nextErrors: string[] = [];
      // 検証中に増えていく暫定の合計サイズ列と枚数（既存分を起点にする）。
      let runningSizes = attachments.map((a) => a.sizeBytes);
      let runningCount = attachments.length;

      for (const file of incoming) {
        const meta = {
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        };

        // (a) 型許可リスト + 単一画像サイズ上限（Req 9.4, 9.5(a)）
        const fileResult = validateImageFile(meta);
        if (!fileResult.ok) {
          nextErrors.push(validationMessage(fileResult.reason, file.name));
          continue;
        }

        // (c) 枚数上限（Req 9.5(c)）
        const countResult = canAcceptMore(runningCount, 1);
        if (!countResult.ok) {
          nextErrors.push(validationMessage(countResult.reason, file.name));
          continue;
        }

        // (b) メッセージ合計予算＝主要ゲート（Req 9.5(b)）
        const budgetResult = withinMessageBudget([...runningSizes, file.size]);
        if (!budgetResult.ok) {
          nextErrors.push(validationMessage(budgetResult.reason, file.name));
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
        onAttachmentsChange([...attachments, ...accepted]);
      }
      // 同一理由の重複メッセージは 1 件に集約する。
      setErrors(Array.from(new Set(nextErrors)));
    },
    [attachments, disabled, onAttachmentsChange],
  );

  // テキスト入力フォーカス中の paste で画像を添付する（Req 9.2）。
  useEffect(() => {
    if (disabled) return;
    const handlePaste = (e: ClipboardEvent) => {
      if (!isTextInputFocused()) return;
      const items = e.clipboardData?.files;
      if (!items || items.length === 0) return;
      const images = Array.from(items).filter(isImageFile);
      if (images.length === 0) return;
      // 画像貼り付けはテキスト入力への挿入ではなく添付として扱う。
      e.preventDefault();
      addFiles(images);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [disabled, addFiles]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      addFiles(Array.from(files));
    }
    // 同じファイルを続けて選択できるように value をリセットする。
    e.target.value = "";
  };

  const handleRemove = (id: string) => {
    const target = attachments.find((a) => a.id === id);
    if (target) {
      URL.revokeObjectURL(target.previewUrl);
      knownUrlsRef.current.delete(target.previewUrl);
    }
    onAttachmentsChange(attachments.filter((a) => a.id !== id));
  };

  const acceptAttr = ACCEPTED_IMAGE_TYPES.join(",");

  return (
    <div className="image-composer">
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptAttr}
        multiple
        onChange={handleFileInputChange}
        disabled={disabled}
        style={{ display: "none" }}
        // ラベルは添付ボタン側で提供するため支援技術には露出させない
        aria-hidden="true"
        tabIndex={-1}
      />

      <button
        type="button"
        className="image-composer__attach-button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        aria-label={attachLabel}
      >
        <svg
          className="image-composer__attach-icon"
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
        <span>画像を添付</span>
      </button>

      {attachments.length > 0 && (
        <ul className="image-composer__previews" aria-label="添付した画像">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="image-composer__preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="image-composer__thumb"
                src={attachment.previewUrl}
                alt={`${attachment.filename} のプレビュー`}
              />
              <span className="image-composer__meta">
                <span className="image-composer__filename" title={attachment.filename}>
                  {attachment.filename}
                </span>
                <span className="image-composer__size">
                  {formatFileSize(attachment.sizeBytes)}
                </span>
              </span>
              <button
                type="button"
                className="image-composer__remove"
                onClick={() => handleRemove(attachment.id)}
                disabled={disabled}
                aria-label={`${attachment.filename} を削除`}
              >
                <svg
                  className="image-composer__remove-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <ul className="image-composer__errors" role="alert">
          {errors.map((message, i) => (
            <li key={i} className="image-composer__error">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ImageAttachmentComposer;
