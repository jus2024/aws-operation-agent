// @vitest-environment jsdom

/**
 * outgoingImageMessage のユニットテスト（Task 11.4）
 *
 * 送信時 base64 インライン送出ロジックの純粋 + 最小 DOM 依存関数を検証する:
 *   - fileToBase64: 成功時に base64 を返し、失敗時は `encode_failed`（例外を投げない）（Req 9.8）
 *   - buildImageContentBlock / buildMultimodalContent: AG-UI の text + image blocks 構築（Req 9.6）
 *   - stripHistoricalImageContent: 過去ターンの画像バイナリをスレッドから除去（Req 9.9）
 *   - prepareOutgoingContent: base64 化 + 転送量見積り（encode_failed / payload_too_large）（Req 9.6, 9.8）
 *
 * 網羅的なサイズ/枚数バリデーションは Property 9（imageAttachment.pbt.test.ts）に委譲し、
 * ここでは送出変換・履歴 strip・エラー表面化の代表例に絞る。
 *
 * Requirements: 9.6, 9.8, 9.9, 8.7
 */

import { describe, it, expect } from "vitest";
import type { Message } from "@ag-ui/client";
import {
  fileToBase64,
  base64TransportBytes,
  buildImageContentBlock,
  buildMultimodalContent,
  stripHistoricalImageContent,
  prepareOutgoingContent,
  type ImageContentBlock,
} from "./outgoingImageMessage";
import { EFFECTIVE_TRANSPORT_MAX_BYTES } from "./imageAttachment";

/** 指定 MIME・内容の File を生成する。 */
function makeFile(name: string, type: string, content: string): File {
  return new File([content], name, { type });
}

describe("fileToBase64", () => {
  it("File を base64 文字列（data: プレフィックス無し）へ変換する", async () => {
    const result = await fileToBase64(makeFile("x.png", "image/png", "hello"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // "hello" の base64 は "aGVsbG8="
      expect(result.data).toBe("aGVsbG8=");
    }
  });

  it("空ファイルは encode_failed を返す（例外を投げない）", async () => {
    const result = await fileToBase64(makeFile("empty.png", "image/png", ""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("encode_failed");
    }
  });
});

describe("base64TransportBytes", () => {
  it("base64 文字列の文字数（= 転送バイト数）を返す", () => {
    expect(base64TransportBytes("aGVsbG8=")).toBe(8);
    expect(base64TransportBytes("")).toBe(0);
  });
});

describe("buildImageContentBlock", () => {
  it("AG-UI の base64 インライン画像ブロックを構築する", () => {
    const block = buildImageContentBlock("image/png", "AAAA");
    expect(block).toEqual({
      type: "image",
      source: { type: "data", value: "AAAA", mimeType: "image/png" },
    });
  });
});

describe("buildMultimodalContent", () => {
  it("画像が無ければプレーンなテキスト文字列を返す", () => {
    expect(buildMultimodalContent("こんにちは", [])).toBe("こんにちは");
  });

  it("画像があればテキストブロック + 画像ブロックの配列を返す", () => {
    const img: ImageContentBlock = buildImageContentBlock("image/png", "AAAA");
    const content = buildMultimodalContent("これは何?", [img]);
    expect(content).toEqual([
      { type: "text", text: "これは何?" },
      img,
    ]);
  });

  it("テキストが空なら画像ブロックのみを返す（空テキストブロックを含めない）", () => {
    const img: ImageContentBlock = buildImageContentBlock("image/jpeg", "BBBB");
    const content = buildMultimodalContent("   ", [img]);
    expect(content).toEqual([img]);
  });
});

describe("stripHistoricalImageContent（Req 9.9）", () => {
  it("配列 content の過去メッセージから画像ブロックを除去しテキストへ畳み込む", () => {
    const messages = [
      {
        id: "m1",
        role: "user",
        content: [
          { type: "text", text: "この画像を見て" },
          {
            type: "image",
            source: { type: "data", value: "BIGBASE64", mimeType: "image/png" },
          },
        ],
      },
    ] as unknown as Message[];

    const stripped = stripHistoricalImageContent(messages);
    expect((stripped[0] as { content: unknown }).content).toBe("この画像を見て");
    // 元の配列は破壊しない
    expect(Array.isArray((messages[0] as { content: unknown }).content)).toBe(true);
  });

  it("文字列 content のメッセージはそのまま維持する", () => {
    const messages = [
      { id: "a", role: "user", content: "テキストのみ" },
      { id: "b", role: "assistant", content: "応答" },
    ] as unknown as Message[];

    const stripped = stripHistoricalImageContent(messages);
    expect((stripped[0] as { content: unknown }).content).toBe("テキストのみ");
    expect((stripped[1] as { content: unknown }).content).toBe("応答");
  });

  it("テキストブロックが無い場合は空文字へ畳み込む", () => {
    const messages = [
      {
        id: "m",
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "data", value: "X", mimeType: "image/png" },
          },
        ],
      },
    ] as unknown as Message[];

    const stripped = stripHistoricalImageContent(messages);
    expect((stripped[0] as { content: unknown }).content).toBe("");
  });
});

describe("prepareOutgoingContent（Req 9.6, 9.8）", () => {
  it("添付が空ならプレーンなテキスト content を返す", async () => {
    const result = await prepareOutgoingContent({ text: "hi", attachments: [] });
    expect(result).toEqual({ ok: true, content: "hi" });
  });

  it("受理済み添付を base64 化して multimodal content を構築する", async () => {
    const result = await prepareOutgoingContent({
      text: "これは何?",
      attachments: [
        { contentType: "image/png", file: makeFile("a.png", "image/png", "hello") },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual([
        { type: "text", text: "これは何?" },
        {
          type: "image",
          source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
        },
      ]);
    }
  });

  it("エンコード失敗時は encode_failed を返し添付を落とさない", async () => {
    const result = await prepareOutgoingContent({
      text: "x",
      attachments: [
        // 空ファイル → fileToBase64 が encode_failed
        { contentType: "image/png", file: makeFile("empty.png", "image/png", "") },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "encode_failed" });
  });

  it("合計ペイロードが実効転送上限を超えたら payload_too_large を返す", async () => {
    // base64 は約 4/3 倍。実効上限（~5MB）を超えるだけの生バイトを与える。
    const rawBytes = Math.ceil((EFFECTIVE_TRANSPORT_MAX_BYTES * 3) / 4) + 1024;
    const bigContent = "a".repeat(rawBytes);
    const result = await prepareOutgoingContent({
      text: "",
      attachments: [
        { contentType: "image/png", file: makeFile("big.png", "image/png", bigContent) },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "payload_too_large" });
  });
});
