/**
 * ユーザーメッセージ `content` の表示用パース（純粋・全域関数）
 *
 * ChatUserMessage が受け取る `content` は、ターンによって形が異なる:
 *   1. 構造化されたマルチモーダル配列（ローカル楽観的送信・`outgoingImageMessage` 由来）。
 *      text ブロック + image ブロック（`source.value` に base64, `source.mimeType` に MIME）。
 *   2. 文字列。通常のテキスト送信ならそのままの本文だが、画像添付ターンでは
 *      ag-ui-strands / AgentCore Memory が content ブロック列の
 *      Python repr（例: `[TextInputContent(text='...'), ImageInputContent(source=...
 *      value='<base64>', mime_type='image/png', metadata=None))]`）を
 *      文字列として返すことがある。この場合、生 base64 と repr ノイズが
 *      バブルへそのまま出てしまう（本バグ）。
 *
 * 本モジュールは両方の形から「表示テキスト」と「画像（MIME + base64）」を抽出する。
 * 例外は投げない全域関数として実装し、抽出に失敗しても安全側（base64 を出さない）へ倒す。
 * React / CopilotKit / DOM に依存しない純粋関数のため単体テスト可能
 * （`imageAttachment.ts` / `outgoingImageMessage.ts` と同じ分離方針）。
 */

/** パース結果。`text` は表示本文、`images` は base64 サムネイル用の画像列。 */
export interface ParsedUserContent {
  text: string;
  images: { mime: string; base64: string }[];
}

/**
 * base64 らしき連続実行（100 文字以上）。誤検出を避けるためやや長めに取る。
 * 末尾のパディング `=` は 0〜2 個。
 */
const BASE64_RUN = /[A-Za-z0-9+/]{100,}={0,2}/g;

/**
 * 文字列が「画像を含む content ブロックの repr」に見えるかの判定に使うマーカー群。
 * いずれか 1 つでも含めば、repr 抽出パスへ入る。
 */
const IMAGE_MARKER = /(mime_type=|mimeType|value=(?:'|")|InputContent\()/;

/**
 * repr 抽出後に残りがちなトークン（Python/JS の repr 断片）。表示テキストから除去する。
 */
const REPR_NOISE_PATTERNS: RegExp[] = [
  /ImageInputContent\([^)]*\)?/g,
  /InputContentDataSource\([^)]*\)?/g,
  /TextInputContent\(/g,
  /metadata=None/g,
  /source=/g,
  /type=(?:'|")[^'"]*(?:'|")/g,
  /mime_type=(?:'|")[^'"]*(?:'|")/g,
  /mimeType\s*:\s*(?:'|")[^'"]*(?:'|")/g,
  /value\s*[:=]\s*(?:'|")\s*(?:'|")/g,
];

/**
 * 配列（マルチモーダルブロック）から text と画像を抽出する。
 * - `type === "text"` の `text` を収集（"\n" 連結）。
 * - image ブロックは `source` から base64（`value` / `data`）と
 *   MIME（`mimeType` / `mediaType` / `mime_type`）を取り出す。
 * - それ以外（binary 等）は無視する。
 */
function parseArrayContent(parts: unknown[]): ParsedUserContent {
  const texts: string[] = [];
  const images: { mime: string; base64: string }[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const type = (part as { type?: unknown }).type;

    if (type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        texts.push(text);
      }
      continue;
    }

    if (type === "image") {
      const source = (part as { source?: unknown }).source;
      if (source && typeof source === "object") {
        const s = source as Record<string, unknown>;
        const base64 =
          (typeof s.value === "string" && s.value) ||
          (typeof s.data === "string" && s.data) ||
          "";
        const mime =
          (typeof s.mimeType === "string" && s.mimeType) ||
          (typeof s.mediaType === "string" && s.mediaType) ||
          (typeof s.mime_type === "string" && s.mime_type) ||
          "image/*";
        if (base64) {
          images.push({ mime, base64 });
        }
      }
      continue;
    }
    // その他のブロック（audio/video/document/binary 等）は表示しない。
  }

  return { text: texts.join("\n"), images };
}

/**
 * repr 文字列からテキスト（`text='...'` / `text="..."`）を抽出して連結する。
 */
function extractReprTexts(content: string): string[] {
  const texts: string[] = [];
  // text='...'（シングルクォート、非貪欲）と text="..."（ダブルクォート）の両対応。
  const textPattern = /text\s*[:=]\s*'([^']*)'|text\s*[:=]\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = textPattern.exec(content)) !== null) {
    const value = match[1] ?? match[2] ?? "";
    if (value.length > 0) {
      texts.push(value);
    }
  }
  return texts;
}

/**
 * repr 文字列から画像（base64 + MIME）を抽出する。
 *
 * Python 形（`value='<base64>' ... mime_type='image/png'`）と
 * JS 形（`value:"<base64>" ... mimeType:"image/png"`）の双方に対応し、
 * かつ value→mime / mime→value の順序どちらでも拾えるように、
 * value と mime を独立に走査して同数だけペアリングする。
 */
function extractReprImages(content: string): { mime: string; base64: string }[] {
  // value='<base64>' / value:"<base64>"（クォートは ' でも " でも可）。
  const valuePattern = /value\s*[:=]\s*(?:'([A-Za-z0-9+/=]+)'|"([A-Za-z0-9+/=]+)")/g;
  // mime_type='image/...' / mimeType:"image/..." / mediaType 等。
  const mimePattern =
    /(?:mime_type|mimeType|mediaType|mime)\s*[:=]\s*(?:'(image\/[^']+)'|"(image\/[^"]+)")/g;

  const values: string[] = [];
  let vMatch: RegExpExecArray | null;
  while ((vMatch = valuePattern.exec(content)) !== null) {
    values.push(vMatch[1] ?? vMatch[2] ?? "");
  }

  const mimes: string[] = [];
  let mMatch: RegExpExecArray | null;
  while ((mMatch = mimePattern.exec(content)) !== null) {
    mimes.push(mMatch[1] ?? mMatch[2] ?? "");
  }

  const images: { mime: string; base64: string }[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const base64 = values[i];
    if (!base64) {
      continue;
    }
    // 対応する MIME が無ければ汎用フォールバック（順序ずれ・欠落に強くする）。
    const mime = mimes[i] ?? "image/*";
    images.push({ mime, base64 });
  }
  return images;
}

/**
 * 表示テキストから base64 実行と repr ノイズを除去する安全ネット。
 * 抽出漏れがあってもバブルへ base64 / repr が漏れないようにする。
 */
function sanitizeText(text: string): string {
  let cleaned = text.replace(BASE64_RUN, "");
  for (const pattern of REPR_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  // 先頭/末尾の余分なブラケット・カンマ・空白を畳む。
  cleaned = cleaned
    .replace(/[[\]]/g, "")
    .replace(/\s*,\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned;
}

/**
 * 文字列 content をパースする。画像マーカーが無ければそのまま本文として返す。
 */
function parseStringContent(content: string): ParsedUserContent {
  if (!IMAGE_MARKER.test(content) && !BASE64_RUN.test(content)) {
    // 通常のテキストメッセージ: 一切加工せずそのまま表示（既存挙動を維持）。
    return { text: content, images: [] };
  }
  // BASE64_RUN は /g のため lastIndex を持ち越す。後続の判定に影響しないようリセット。
  BASE64_RUN.lastIndex = 0;

  const texts = extractReprTexts(content);
  const images = extractReprImages(content);

  // 抽出したテキストを結合し、安全ネットで base64/repr ノイズを除去する。
  const joined = texts.join("\n");
  const text = sanitizeText(joined);

  return { text, images };
}

/**
 * ユーザーメッセージ `content` を表示用に解釈する（全域・例外を投げない）。
 *
 * - 配列（マルチモーダル）→ text + images を抽出。
 * - 文字列 → 画像マーカーがあれば repr から text/images を抽出し、
 *   base64/repr ノイズを除去。マーカーが無ければそのまま本文として返す。
 * - それ以外（null/undefined/数値等）→ 空。
 */
export function parseUserMessageContent(content: unknown): ParsedUserContent {
  if (typeof content === "string") {
    return parseStringContent(content);
  }
  if (Array.isArray(content)) {
    return parseArrayContent(content);
  }
  return { text: "", images: [] };
}
