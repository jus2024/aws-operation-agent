/**
 * userMessageContent のユニットテスト
 *
 * ChatUserMessage の表示用パース（純粋・全域）を検証する:
 *   - 通常のテキスト文字列は無加工で返す（既存挙動の維持）。
 *   - マルチモーダル配列は text と画像（base64 + MIME）を抽出し、text に base64 を残さない。
 *   - 画像添付ターンの Python-repr 文字列から text と画像を抽出し、
 *     返す text に生 base64 を含めない（本バグの回帰防止）。
 *   - 生 base64 のみの文字列でも text に base64 を残さない。
 */

import { describe, it, expect } from "vitest";
import { parseUserMessageContent } from "./userMessageContent";

/** 長い base64 らしき文字列（100 文字以上のマーカー閾値を確実に超える）。 */
const LONG_BASE64 = "A".repeat(400);

describe("parseUserMessageContent", () => {
  it("通常のテキスト文字列はそのまま返す（画像なし）", () => {
    const result = parseUserMessageContent("こんにちは、これは普通のメッセージです");
    expect(result).toEqual({
      text: "こんにちは、これは普通のメッセージです",
      images: [],
    });
  });

  it("空文字列はそのまま空で返す", () => {
    expect(parseUserMessageContent("")).toEqual({ text: "", images: [] });
  });

  it("null / undefined / 数値は空を返す（例外を投げない）", () => {
    expect(parseUserMessageContent(null)).toEqual({ text: "", images: [] });
    expect(parseUserMessageContent(undefined)).toEqual({ text: "", images: [] });
    expect(parseUserMessageContent(42)).toEqual({ text: "", images: [] });
  });

  it("マルチモーダル配列から text と画像を抽出する（text に base64 を残さない）", () => {
    const content = [
      { type: "text", text: "この画像を見て" },
      {
        type: "image",
        source: { type: "data", value: LONG_BASE64, mimeType: "image/png" },
      },
    ];
    const result = parseUserMessageContent(content);
    expect(result.text).toBe("この画像を見て");
    expect(result.images).toEqual([{ mime: "image/png", base64: LONG_BASE64 }]);
    expect(result.text).not.toContain(LONG_BASE64);
  });

  it("配列で source.data / source.mediaType など別名も拾う", () => {
    const content = [
      {
        type: "image",
        source: { data: LONG_BASE64, mediaType: "image/jpeg" },
      },
    ];
    const result = parseUserMessageContent(content);
    expect(result.images).toEqual([{ mime: "image/jpeg", base64: LONG_BASE64 }]);
  });

  it("配列内の非テキスト・非画像ブロックは無視する", () => {
    const content = [
      { type: "text", text: "hi" },
      { type: "audio", source: { value: "xxxx" } },
    ];
    const result = parseUserMessageContent(content);
    expect(result.text).toBe("hi");
    expect(result.images).toEqual([]);
  });

  it("Python-repr 文字列から text と画像を抽出し、text に base64 を含めない", () => {
    const content =
      "[TextInputContent(text='この画像を見て'), ImageInputContent(source=InputContentDataSource(type='data', value='" +
      LONG_BASE64 +
      "', mime_type='image/png', metadata=None))]";
    const result = parseUserMessageContent(content);
    expect(result.text).toBe("この画像を見て");
    expect(result.images).toEqual([{ mime: "image/png", base64: LONG_BASE64 }]);
    // 生 base64 が表示テキストへ漏れていないこと（本バグの回帰防止）。
    expect(result.text).not.toContain(LONG_BASE64);
  });

  it("JS-repr 形（value:\"...\" + mimeType:\"...\"）からも画像を抽出する", () => {
    const content =
      '[{type:"text",text:"見て"},{type:"image",source:{value:"' +
      LONG_BASE64 +
      '",mimeType:"image/webp"}}]';
    const result = parseUserMessageContent(content);
    expect(result.text).toBe("見て");
    expect(result.images).toEqual([{ mime: "image/webp", base64: LONG_BASE64 }]);
    expect(result.text).not.toContain(LONG_BASE64);
  });

  it("mime→value の順序でもペアリングできる", () => {
    const content =
      "ImageInputContent(source=InputContentDataSource(mime_type='image/gif', value='" +
      LONG_BASE64 +
      "', metadata=None))";
    const result = parseUserMessageContent(content);
    expect(result.images).toEqual([{ mime: "image/gif", base64: LONG_BASE64 }]);
    expect(result.text).not.toContain(LONG_BASE64);
  });

  it("バリ生 base64 のみの文字列でも text に base64 を残さない", () => {
    const result = parseUserMessageContent(LONG_BASE64);
    expect(result.text).not.toContain(LONG_BASE64);
  });

  it("画像 2 枚を含む repr から両方の画像を抽出する", () => {
    const b1 = "B".repeat(200);
    const b2 = "C".repeat(200);
    const content =
      "[ImageInputContent(source=InputContentDataSource(type='data', value='" +
      b1 +
      "', mime_type='image/png', metadata=None)), " +
      "ImageInputContent(source=InputContentDataSource(type='data', value='" +
      b2 +
      "', mime_type='image/jpeg', metadata=None))]";
    const result = parseUserMessageContent(content);
    expect(result.images).toEqual([
      { mime: "image/png", base64: b1 },
      { mime: "image/jpeg", base64: b2 },
    ]);
    expect(result.text).not.toContain(b1);
    expect(result.text).not.toContain(b2);
  });
});
