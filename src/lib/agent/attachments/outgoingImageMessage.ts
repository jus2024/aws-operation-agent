/**
 * 送信時の base64 インライン画像送出ロジック（純粋 + 最小限の DOM 依存）
 *
 * Composer（`ImageAttachmentComposer`）が受理した画像添付を、CopilotKit v2 /
 * AG-UI の multimodal ユーザーメッセージ（text + image content blocks）へ変換する。
 * 既存の接続経路（`/api/copilotkit` + SigV4 + HttpAgent → AgentCore）を一切変更せず、
 * ユーザーメッセージの `content` を「テキストブロック + 画像ブロック」の配列として
 * 送ることで相乗りさせる（Req 9.6, 8.7）。
 *
 * 本モジュールは UI / React / CopilotKit フックに依存しない（`useImageMessageSender`
 * が本モジュールを呼び出して `useAgent` に配線する）。base64 化のみ `FileReader` を
 * 使うためブラウザ/jsdom を要するが、それ以外は純粋関数として単体テスト可能。
 *
 *   - `fileToBase64`         : File を base64 文字列へ（失敗は `encode_failed`）（Req 9.8）
 *   - `buildImageContentBlock`: AG-UI の画像コンテンツブロックを構築（Req 9.6）
 *   - `buildMultimodalContent`: text + image blocks の content を構築（Req 9.6）
 *   - `stripHistoricalImageContent`: 過去ターンの画像バイナリをスレッドから除去（Req 9.9）
 *   - `prepareOutgoingContent`: 受理済み添付を base64 化し、転送上限を見積って
 *                               送出用 content を返す全域オーケストレータ（Req 9.6, 9.8）
 *
 * Requirements: 9.6, 9.8, 9.9, 8.7
 */

import type { Message } from "@ag-ui/client";
import {
  withinTransportLimit,
  type ImageAttachmentError,
} from "./imageAttachment";

/** 送信前の画像添付（Composer の `PendingImageAttachment` の送出に必要な最小形）。 */
export interface SendableImageAttachment {
  /** 例: "image/png" */
  contentType: string;
  /** base64 化する元ファイル */
  file: File;
}

/** AG-UI ユーザーメッセージのテキストコンテンツブロック（Req 9.6）。 */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * AG-UI ユーザーメッセージの画像コンテンツブロック（base64 インライン）（Req 9.6）。
 * `source.type: "data"` の base64 値としてインライン送出し、S3 参照は用いない（Req 8.7）。
 */
export interface ImageContentBlock {
  type: "image";
  source: {
    type: "data";
    value: string;
    mimeType: string;
  };
}

export type MultimodalContentBlock = TextContentBlock | ImageContentBlock;

/**
 * 送出するユーザーメッセージ `content`。画像が無ければプレーンなテキスト文字列、
 * 画像があれば text + image ブロックの配列（multimodal content）。
 */
export type OutgoingUserContent = string | MultimodalContentBlock[];

/** 送出用 content の準備結果（総和型・例外を投げない）。 */
export type PrepareOutgoingResult =
  | { ok: true; content: OutgoingUserContent }
  | { ok: false; reason: ImageAttachmentError };

/**
 * `File` を base64 文字列（`data:` プレフィックス無しの純粋な base64）へ変換する。
 *
 * 読み込み/変換に失敗した場合は `encode_failed` を返し、例外を投げない（Req 9.8）。
 * ブラウザ/jsdom の `FileReader` を用いる。`readAsDataURL` の結果
 * （`data:<mime>;base64,<data>`）からカンマ以降の base64 部分を取り出す。
 */
export function fileToBase64(
  file: File,
): Promise<{ ok: true; data: string } | { ok: false; reason: "encode_failed" }> {
  return new Promise((resolve) => {
    try {
      if (typeof FileReader === "undefined") {
        resolve({ ok: false, reason: "encode_failed" });
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => resolve({ ok: false, reason: "encode_failed" });
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          resolve({ ok: false, reason: "encode_failed" });
          return;
        }
        const commaIndex = result.indexOf(",");
        const data = commaIndex >= 0 ? result.slice(commaIndex + 1) : "";
        if (data.length === 0) {
          resolve({ ok: false, reason: "encode_failed" });
          return;
        }
        resolve({ ok: true, data });
      };
      reader.readAsDataURL(file);
    } catch {
      resolve({ ok: false, reason: "encode_failed" });
    }
  });
}

/**
 * base64 文字列が送出時に占めるおおよそのバイト数（転送量見積り用）。
 *
 * base64 は ASCII 文字のみのため、JSON へ載る際のバイト数は文字数と一致する。
 * 転送上限判定（`withinTransportLimit`）へ渡すサイズとして用いる（Req 9.8）。
 */
export function base64TransportBytes(base64: string): number {
  return base64.length;
}

/** base64 と MIME から AG-UI の画像コンテンツブロックを構築する（純粋）（Req 9.6）。 */
export function buildImageContentBlock(
  mimeType: string,
  base64: string,
): ImageContentBlock {
  return {
    type: "image",
    source: { type: "data", value: base64, mimeType },
  };
}

/**
 * text と画像ブロックから送出用の `content` を構築する（純粋）（Req 9.6）。
 *
 * - 画像が無ければプレーンなテキスト文字列を返す（既存のテキスト送出と同一形状）。
 * - 画像があれば配列を返す。テキストが非空のときのみ先頭にテキストブロックを含め、
 *   続けて画像ブロックを並べる。
 */
export function buildMultimodalContent(
  text: string,
  imageBlocks: ImageContentBlock[],
): OutgoingUserContent {
  if (imageBlocks.length === 0) {
    return text;
  }
  const blocks: MultimodalContentBlock[] = [];
  if (text.trim().length > 0) {
    blocks.push({ type: "text", text });
  }
  blocks.push(...imageBlocks);
  return blocks;
}

/** content が multimodal ブロック配列かどうか（純粋・型ガード）。 */
function isBlockArrayContent(content: unknown): content is Array<{ type?: unknown }> {
  return Array.isArray(content);
}

/**
 * スレッド（メッセージ列）から過去ターンの画像等のバイナリブロックを除去する（Req 9.9）。
 *
 * CopilotKit はターンごとにスレッド全体を再送するため、過去ターンの画像 base64 を
 * 含め続けるとリクエストが肥大化し容易に転送上限を超える。そこで送信直前に、
 * 配列 content を持つ過去メッセージから `text` 以外のブロック（image/audio/video/
 * document/binary など、バイナリを運ぶブロック）を除去し、残ったテキストのみを
 * 文字列 content へ畳み込む。会話履歴としての画像の文脈はテキスト（および
 * AgentCore Memory 側の履歴保持）に依存させ、画像バイトそのものは再送しない。
 *
 * 文字列 content のメッセージ（通常のテキスト・アシスタント応答）はそのまま返す。
 * 純粋関数（入力を破壊しない）。
 */
export function stripHistoricalImageContent(messages: Message[]): Message[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!isBlockArrayContent(content)) {
      return message;
    }
    const textParts = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    return {
      ...(message as object),
      content: textParts.join("\n"),
    } as Message;
  });
}

/**
 * 受理済み添付を base64 化し、転送上限を見積って送出用 content を返す（全域）。
 *
 * 手順（Req 9.6, 9.8）:
 *   1. 各添付を base64 化する。いずれかが失敗したら `encode_failed` を返し、
 *      添付を黙って落とさない（呼び出し側がエラー表示する）。
 *   2. 合計ペイロード（各画像の base64 サイズ + テキストのバイト数）を
 *      `withinTransportLimit`（実効上限 `EFFECTIVE_TRANSPORT_MAX_BYTES` ≈ 5MB）で
 *      見積る。超過したら `payload_too_large` を返し送出しない。
 *   3. text + image blocks の multimodal content を構築して返す。
 *
 * 添付が空の場合はプレーンなテキスト文字列を返す（画像無しの通常送出）。
 */
export async function prepareOutgoingContent(params: {
  text: string;
  attachments: SendableImageAttachment[];
}): Promise<PrepareOutgoingResult> {
  const { text, attachments } = params;

  const imageBlocks: ImageContentBlock[] = [];
  const transportSizes: number[] = [];

  for (const attachment of attachments) {
    const encoded = await fileToBase64(attachment.file);
    if (!encoded.ok) {
      return { ok: false, reason: "encode_failed" };
    }
    imageBlocks.push(buildImageContentBlock(attachment.contentType, encoded.data));
    transportSizes.push(base64TransportBytes(encoded.data));
  }

  // テキスト分も合計見積りに含める（UTF-8 バイト長）。
  transportSizes.push(textByteLength(text));

  const transportResult = withinTransportLimit(transportSizes);
  if (!transportResult.ok) {
    return { ok: false, reason: transportResult.reason };
  }

  return { ok: true, content: buildMultimodalContent(text, imageBlocks) };
}

/** 文字列の UTF-8 バイト長（転送量見積りの補助・純粋）。 */
function textByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // TextEncoder 非対応環境向けのフォールバック（テスト環境では通常到達しない）。
  return unescape(encodeURIComponent(text)).length;
}
