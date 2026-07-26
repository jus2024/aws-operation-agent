/**
 * AgentCore Memory の ListEvents レスポンスをフィルタリング・変換する
 * 純粋関数群。`relay.ts` と同様に「純粋関数 + I/O ヘルパー」構成を取り、
 * I/O（`bedrock-agentcore:ListEvents` の実際の呼び出し）は `handler.ts` 側の
 * ルーティング分岐（タスク 3）で行う。このモジュール自体は AWS SDK や
 * ネットワーク呼び出しに依存しない。
 *
 * Requirements: 2.2, 2.6, 2.7, 5.1
 */

/**
 * `bedrock-agentcore:ListEvents` レスポンスの Event 要素の部分型。
 *
 * `payload[0]` は以下のいずれか:
 * - `conversational`: ユーザー発言・アシスタント応答等の会話内容
 * - `blob`: AGENT/SESSION の内部状態イベント（会話内容ではない）
 */
export interface MemoryEvent {
  eventId: string;
  eventTimestamp: string;
  payload: Array<
    | { conversational: { role: string; content: { text: string } } }
    | { blob: unknown }
  >;
}

/**
 * ListEvents の結果から `payload[0].conversational` を持つイベントのみを
 * 抽出する（`payload[0].blob` を持つ AGENT/SESSION 状態イベントは除外する）。
 *
 * 入力の相対順序を保ったまま返す純粋関数。`payload` が空配列のイベント
 * （`payload[0]` が存在しない）は `conversational` を持たないため除外する。
 *
 * Validates: Requirements 2.2
 */
export function filterConversationalEvents(events: MemoryEvent[]): MemoryEvent[] {
  return events.filter((event) => {
    const firstPayloadItem = event.payload[0];
    return firstPayloadItem !== undefined && "conversational" in firstPayloadItem;
  });
}

/**
 * `parseConversationalEventPayload` が返す、パース済みの1メッセージ分の内容。
 * `content` は Bedrock Converse API のコンテンツブロック配列（`text` ブロック、
 * `toolUse` ブロック、`toolResult` ブロック等）を想定するが、この段階では
 * 個々の要素の形状までは検証しない（タスク 2.3 の `convertMemoryEventsToAGUIMessages`
 * が toolUse/toolResult ブロックを読み取る際に検証する）。
 */
export interface ParsedConversationalMessage {
  role: "user" | "assistant";
  content: unknown[];
}

/**
 * `payload[0].conversational.content.text` の JSON 文字列をパースし、
 * `{ role, content }` 形式に変換する純粋関数。
 *
 * **JSON 文字列の想定形状（解釈の明記）**: design.md は `message.role` /
 * `message.content` という参照のみを示しており、`text` フィールドに入る JSON
 * 文字列の厳密な外側の構造までは仕様化していない。本実装では、Bedrock
 * Converse API のメッセージ形式（`{ role, content: ContentBlock[] }`）に、
 * AgentCore Memory の Event 記録がそれを1件分ラップした
 * `{ message: { role, content } }` という形状を採用する。この解釈を採用した
 * 理由: (1) design.md が明示する参照パス `message.role`/`message.content` は
 * ネストされた `message` オブジェクトの存在を前提にした記述であること、
 * (2) `content` は「toolUse ブロックを含む配列」（Requirements 2.6）である
 * 必要があり、Converse API の `content: ContentBlock[]` 形状と整合すること。
 * 暗黙の規約より明示的な設定を優先する方針に基づき、この解釈をここに明記する。
 *
 * 以下のいずれかに該当する場合は例外を投げず `null` を返す:
 * - `event.payload[0]` が存在しない、または `conversational` を持たない
 * - `text` が有効な JSON として解釈できない
 * - パース結果が `message` オブジェクトを持たない
 * - `message.role` が `"user"` / `"assistant"` のいずれでもない
 * - `message.content` が配列でない
 *
 * Validates: Requirements 2.7
 */
export function parseConversationalEventPayload(
  event: MemoryEvent
): ParsedConversationalMessage | null {
  const firstPayloadItem = event.payload[0];
  if (firstPayloadItem === undefined || !("conversational" in firstPayloadItem)) {
    return null;
  }

  const text = firstPayloadItem.conversational.content.text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return extractMessageFromSessionDict(parsed);
}

/**
 * パース済みの session_dict（`{ message: { role, content } }` 形状）から
 * `{ role, content }` を取り出す共通ヘルパー（全域・例外を投げない）。
 *
 * `parseConversationalEventPayload`（conversational 経路）と
 * `parseBlobEventPayload`（blob 経路）の双方が、Strands の
 * `SessionMessage.to_dict()` が生成する同一の `{ message: { role, content } }`
 * 形状を読むため、抽出ロジックをここに集約する。以下のいずれかに該当する場合は
 * `null` を返す:
 * - `parsed` がオブジェクトでない
 * - `message` オブジェクトを持たない
 * - `message.role` が `"user"` / `"assistant"` のいずれでもない
 * - `message.content` が配列でない
 */
function extractMessageFromSessionDict(parsed: unknown): ParsedConversationalMessage | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const role = (message as { role?: unknown }).role;
  const content = (message as { content?: unknown }).content;

  if (role !== "user" && role !== "assistant") {
    return null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  return { role, content };
}

/**
 * `payload[0].blob` を持つイベントを、それが「会話メッセージを運ぶ blob」で
 * ある場合に限り `{ role, content }` へデコードする純粋関数（全域・例外を投げない）。
 *
 * **背景（blob 経路が必要な理由）**: あるターンをシリアライズした JSON が
 * AgentCore Memory の conversational テキスト上限（`CONVERSATIONAL_MAX_SIZE =
 * 100000` 文字）を超えると、そのターンは `conversational` ではなく `blob`
 * ペイロードのイベントとして保存される（base64 画像バイトを含むターンは容易に
 * この上限を超える）。conversational だけを読む復元経路では、そうしたターンが
 * テキストごと黙って落ちてしまう（画像だけでなく本文も消える）。本関数はこれを
 * 復元するために追加する。
 *
 * **Python 参照（`AgentCoreMemoryConverter.events_to_messages` /
 * `bedrock_converter.py`）のミラー**:
 * - Python は `blob_data = json.loads(payload_item["blob"])` で blob をパースする。
 *   会話メッセージ blob は `session_manager` 側で `json.dumps(messages[0])` として
 *   保存されており、`messages[0]` は `message_to_payload` が返す 2 要素タプル
 *   `(json.dumps(session_dict), role)` である。したがって `blob_data` は 2 要素配列
 *   `[messageJsonStr, role]` になる（`messageJsonStr` は `{ message: { role, content }, ... }`
 *   をシリアライズした JSON 文字列）。
 * - Python は `blob_data` が 2 要素の list/tuple のとき
 *   `SessionMessage.from_dict(json.loads(blob_data[0]))` で復元し、それ以外
 *   （AGENT/SESSION の内部状態オブジェクト等）は「SessionMessage ではない」として
 *   無視する。
 *
 * **JS SDK の blob 型（`@aws-sdk/client-bedrock-agentcore`）**: `payload[].blob` は
 * `PayloadType.BlobMember.blob: __DocumentType`（= `@smithy/types` の `DocumentType`
 * = `null | boolean | number | string | DocumentType[] | { [k]: DocumentType }`）
 * であり、`Uint8Array` ではない（untyped な JSON 値）。実行時値は SDK の
 * デシリアライズにより「素の JSON 文字列」または「パース済みの配列」のいずれも
 * 取り得るため、両方を受理する（string の場合は `JSON.parse`、配列の場合はそのまま）。
 * `blob_data[0]`（= `messageJsonStr`）は JSON 文字列値のまま残るため、さらに
 * `JSON.parse` して `{ message: { role, content } }` を得てから
 * `extractMessageFromSessionDict` に渡す（conversational 経路と同一の抽出を再利用）。
 *
 * 会話メッセージを運ばない blob（2 要素配列でない、[0] が文字列でない、
 * オブジェクト/agent-state 等）は `null` を返して無視する。
 *
 * Validates: Requirements 2.7
 */
export function parseBlobEventPayload(event: MemoryEvent): ParsedConversationalMessage | null {
  const firstPayloadItem = event.payload[0];
  if (firstPayloadItem === undefined || !("blob" in firstPayloadItem)) {
    return null;
  }

  const blob = firstPayloadItem.blob;

  // blob は「JSON 文字列」または「デシリアライズ済みの JSON 値（配列等）」を取り得る。
  // 文字列なら 1 段パースして中身を得る。オブジェクト/数値/null 等はそのまま扱い、
  // 下の 2 要素配列チェックで弾く（会話メッセージ blob ではない）。
  let blobData: unknown = blob;
  if (typeof blob === "string") {
    try {
      blobData = JSON.parse(blob);
    } catch {
      return null;
    }
  }

  // 会話メッセージ blob は 2 要素配列 `[messageJsonStr, role]`。それ以外
  // （AGENT/SESSION 内部状態オブジェクト等）は会話メッセージではないため無視する。
  if (!Array.isArray(blobData) || blobData.length !== 2) {
    return null;
  }

  const messageJson = blobData[0];
  if (typeof messageJson !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(messageJson);
  } catch {
    return null;
  }

  return extractMessageFromSessionDict(parsed);
}

/**
 * 1 件の `MemoryEvent` を、それが会話メッセージを運ぶ場合に `{ role, content }`
 * へデコードする統合ディスパッチ（全域・例外を投げない）。
 *
 * - `payload[0]` が `conversational` を持つ → `parseConversationalEventPayload`
 * - `payload[0]` が `blob` を持つ → `parseBlobEventPayload`（会話メッセージ blob のみ復元）
 * - いずれでもない / 会話メッセージでない → `null`
 *
 * `handler.ts` はこの関数を用いて blob イベントを「事前に落とさず」に処理する
 * （従来は `filterConversationalEvents` が blob を除外していたため、上限超過ターンが
 * 消えていた）。`filterConversationalEvents` / `parseConversationalEventPayload` は
 * 既存の conversational 挙動・テストのためにそのまま残す。
 *
 * Validates: Requirements 2.2, 2.7
 */
export function parseEventPayload(event: MemoryEvent): ParsedConversationalMessage | null {
  const firstPayloadItem = event.payload[0];
  if (firstPayloadItem === undefined) {
    return null;
  }
  if ("conversational" in firstPayloadItem) {
    return parseConversationalEventPayload(event);
  }
  if ("blob" in firstPayloadItem) {
    return parseBlobEventPayload(event);
  }
  return null;
}

/**
 * ユーザーメッセージのマルチモーダルコンテンツブロック（復元時の構造化配列）。
 *
 * 送信時（`src/lib/agent/attachments/outgoingImageMessage.ts` の
 * `buildImageContentBlock` / `buildMultimodalContent`）と同一形状にそろえることで、
 * 復元された画像ユーザーターンが送信時と同じサムネイルとして描画される
 * （`parseUserMessageContent` の配列分岐が `type` と `source.value`/`source.mimeType`
 * を読む）。`type: "data"` も送信時の `ImageContentBlock` に合わせて保持する。
 */
export type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "data"; value: string; mimeType: string };
    };

/**
 * AG-UI / CopilotKit の Message 型の判別可能なユニオン（design.md の
 * Data Models セクションで定義された `AGUIMessage` と同一の形状）。
 *
 * - text メッセージ: `role` が `"user"` または `"assistant"` で本文（`content`）を持つ
 * - user マルチモーダルメッセージ: `role` が `"user"` で `content` が構造化ブロック配列
 *   （text + image）。画像添付ターンの復元に用いる（送信時の multimodal 形状に一致）。
 * - toolCall メッセージ: `role` が `"assistant"` で `toolCallId`/`toolCallName`/`toolCallArgs` を持つ
 * - toolResult メッセージ: `role` が `"tool"` で `toolCallId`（元の toolUse に紐付くキー）と結果本文を持つ
 *
 * `createdAt`（任意・epoch ミリ秒）は、復元元 Memory_Event の `eventTimestamp`
 * （1 秒解像度・保存時刻）を `Date.parse` した値。フロントエンドがメッセージ行に
 * 記録時刻（HH:MM）を表示するために付与する（追加的・任意フィールドであり、
 * パースできない/欠落する場合は省略する。既存の変換挙動・レスポンス形状は変えない）。
 */
export type AGUIMessage =
  | { id: string; role: "user" | "assistant"; content: string; createdAt?: number }
  | { id: string; role: "user"; content: UserContentBlock[]; createdAt?: number }
  | {
      id: string;
      role: "assistant";
      toolCallId: string;
      toolCallName: string;
      toolCallArgs: Record<string, unknown>;
      createdAt?: number;
    }
  | { id: string; role: "tool"; toolCallId: string; content: string; createdAt?: number };

interface TextContentBlock {
  text: string;
}

interface ToolUseContentBlock {
  toolUse: {
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
  };
}

interface ToolResultContentBlock {
  toolResult: {
    toolUseId: string;
    content: unknown;
  };
}

function isTextContentBlock(block: unknown): block is TextContentBlock {
  return typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string";
}

function isToolUseContentBlock(block: unknown): block is ToolUseContentBlock {
  if (typeof block !== "object" || block === null) return false;
  const toolUse = (block as { toolUse?: unknown }).toolUse;
  if (typeof toolUse !== "object" || toolUse === null) return false;
  const toolUseId = (toolUse as { toolUseId?: unknown }).toolUseId;
  const name = (toolUse as { name?: unknown }).name;
  return typeof toolUseId === "string" && toolUseId.length > 0 && typeof name === "string";
}

function isToolResultContentBlock(block: unknown): block is ToolResultContentBlock {
  if (typeof block !== "object" || block === null) return false;
  const toolResult = (block as { toolResult?: unknown }).toolResult;
  if (typeof toolResult !== "object" || toolResult === null) return false;
  const toolUseId = (toolResult as { toolUseId?: unknown }).toolUseId;
  return typeof toolUseId === "string" && toolUseId.length > 0;
}

/**
 * Bedrock Converse（Strands）の画像コンテンツブロックの部分型。
 *
 * AgentCore Memory に保存された画像は、送出時に `ag_ui_strands` が AG-UI の
 * `ImageInputContent` を Strands Converse の `{ image: { format, source: { bytes } } }`
 * へ変換したもの（`agents/.../model/test_multimodal_smoke.py` で検証済み）。
 * さらに Strands の `SessionMessage.to_dict()`（`encode_bytes_values`）が `bytes` を
 * `{ __bytes_encoded__: true, data: "<base64>" }` へ base64 エンコードしてから
 * `bedrock_converter.py` が `json.dumps` するため、復元時の `source.bytes` は
 * 「base64 を包んだオブジェクト」または（将来の互換のため）素の base64 文字列を取り得る。
 */
interface ImageContentBlock {
  image: {
    format?: string;
    source?: {
      bytes?: unknown;
    };
  };
}

function isImageContentBlock(block: unknown): block is ImageContentBlock {
  if (typeof block !== "object" || block === null) return false;
  const image = (block as { image?: unknown }).image;
  return typeof image === "object" && image !== null;
}

/**
 * 保存済み画像ブロックから base64 と MIME タイプを取り出す（全域・例外を投げない）。
 *
 * `source.bytes` は次のいずれかを許容する:
 * - Strands の base64 包み: `{ __bytes_encoded__: true, data: "<base64>" }`
 * - 素の base64 文字列（将来/別経路の互換）
 *
 * MIME は `image.format`（"png"/"jpeg"/"gif"/"webp" 等）から `image/<format>` を組み立てる。
 * base64 が取り出せない場合は `null` を返す（呼び出し側がフォールバック表示する）。
 */
function extractImageBlock(
  block: ImageContentBlock,
): { base64: string; mimeType: string } | null {
  const source = block.image.source;
  let base64 = "";
  if (source && typeof source === "object") {
    const bytes = (source as { bytes?: unknown }).bytes;
    if (typeof bytes === "string") {
      base64 = bytes;
    } else if (bytes && typeof bytes === "object") {
      const data = (bytes as { data?: unknown }).data;
      if (typeof data === "string") {
        base64 = data;
      }
    }
  }
  if (base64.length === 0) {
    return null;
  }
  const format = typeof block.image.format === "string" ? block.image.format : "";
  const mimeType = format.length > 0 ? `image/${format}` : "image/*";
  return { base64, mimeType };
}

/**
 * 画像ブロックを含む user イベントを、送信時と同一形状の構造化配列コンテンツを持つ
 * 1 件の user AGUIMessage に変換する（順序を保持）。
 *
 * - text ブロックは `{ type: "text", text }` として順番どおりに含める。
 * - image ブロックは `{ type: "image", source: { type: "data", value, mimeType } }` として含める。
 * - base64 を取り出せなかった image ブロックは、ターンから画像が黙って消えないよう
 *   `{ type: "text", text: "🖼 画像" }` のプレースホルダに置き換える。
 * - 何も含められなかった場合も同じプレースホルダ 1 件でターンの消失を防ぐ。
 */
function buildUserMultimodalMessage(
  content: unknown[],
  eventIndex: number,
  createdAt?: number,
): AGUIMessage {
  const blocks: UserContentBlock[] = [];

  content.forEach((block) => {
    if (isTextContentBlock(block)) {
      blocks.push({ type: "text", text: block.text });
      return;
    }
    if (isImageContentBlock(block)) {
      const extracted = extractImageBlock(block);
      if (extracted) {
        blocks.push({
          type: "image",
          source: {
            type: "data",
            value: extracted.base64,
            mimeType: extracted.mimeType,
          },
        });
      } else {
        // base64 を復元できない画像ブロックはプレースホルダに置換（ターンを消さない）。
        blocks.push({ type: "text", text: "🖼 画像" });
      }
      return;
    }
    // その他のブロック（toolResult 等）は画像ターンでは想定しないため無視する。
  });

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "🖼 画像" });
  }

  return {
    id: `event-${eventIndex}-user-multimodal`,
    role: "user",
    content: blocks,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/**
 * `eventTimestamp`（ISO 8601 文字列）を epoch ミリ秒へ変換する（全域・例外を投げない）。
 * パースできない/未指定の場合は `undefined` を返し、呼び出し側は `createdAt` を省略する。
 */
function parseCreatedAt(eventTimestamp?: string): number | undefined {
  if (typeof eventTimestamp !== "string" || eventTimestamp.length === 0) {
    return undefined;
  }
  const ms = Date.parse(eventTimestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `toolResult.content` は Bedrock Converse API 上ではコンテンツブロック配列や
 * オブジェクトになり得るため、AG-UI の tool メッセージが要求する文字列本文へ
 * 決定的に変換する（例外を投げない）。
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

/**
 * パース済みイベント列（`parseConversationalEventPayload` の出力を
 * パース失敗分を除いて並べたもの）を、CopilotKit/AG-UI が理解できる
 * Message 形式（text / toolCall / toolResult）に変換する純粋関数。
 *
 * - `assistant` イベントの content 配列に含まれる `text` ブロックは
 *   text メッセージ（`role: "assistant"`）に変換する。
 * - `assistant` イベントの content 配列に含まれる `toolUse` ブロックは、
 *   `toolUseId` をキーとした toolCall メッセージ（ツールカード相当）に変換する。
 * - `user` イベントの content 配列に含まれる `text` ブロックは
 *   text メッセージ（`role: "user"`）に変換する。
 * - `user` イベントの content 配列に含まれる `toolResult` ブロックは、
 *   同じ `toolUseId` を持つ toolCall メッセージにのみ紐付く toolResult
 *   メッセージ（`role: "tool"`）に変換する（Requirements 2.6）。
 * - 上記のいずれの形にも当てはまらないコンテンツブロック（想定外の形状）は
 *   安全に無視する（Requirements 2.7 のフォールバック方針を content block
 *   単位でも適用する）。
 * - 入力配列の順序（イベント順・イベント内のブロック順）をそのまま保った
 *   まま出力に反映する（Requirements 2.2）。id はイベントの配列インデックス、
 *   またはツール呼び出しの場合は `toolUseId` から決定的に導出するため、
 *   同一入力に対して常に同一の出力を返す（ランダム性を持たない）。
 * - 各パース済みイベントが `eventTimestamp`（元 Memory_Event の記録時刻・ISO 文字列）
 *   を持つ場合、そのイベント由来の全メッセージに `createdAt`（`Date.parse` した epoch
 *   ミリ秒）を付与する。パース不能/欠落時は `createdAt` を省略する（追加的・任意で、
 *   既存の出力形状・順序は変えない）。
 *
 * Validates: Requirements 2.2, 2.6
 */
export function convertMemoryEventsToAGUIMessages(
  parsedEvents: Array<{ role: "user" | "assistant"; content: unknown[]; eventTimestamp?: string }>
): AGUIMessage[] {
  const messages: AGUIMessage[] = [];

  parsedEvents.forEach((event, eventIndex) => {
    // 復元元イベントの記録時刻（epoch ミリ秒）。パース不能/欠落時は undefined で、
    // その場合 createdAt は省略する（追加的・任意フィールド）。
    const createdAt = parseCreatedAt(event.eventTimestamp);
    const withCreatedAt = createdAt !== undefined ? { createdAt } : {};

    // 画像ブロックを含む user ターンは、送信時と同じ multimodal 形状（text + image）の
    // 1 件の user メッセージにまとめて復元する（Req: 画像ユーザーターンの復元）。
    // これにより復元履歴でも送信時と同じサムネイルが表示される。
    if (event.role === "user" && event.content.some(isImageContentBlock)) {
      messages.push(buildUserMultimodalMessage(event.content, eventIndex, createdAt));
      return;
    }

    event.content.forEach((block, blockIndex) => {
      if (isTextContentBlock(block)) {
        messages.push({
          id: `event-${eventIndex}-text-${blockIndex}`,
          role: event.role,
          content: block.text,
          ...withCreatedAt,
        });
        return;
      }

      if (event.role === "assistant" && isToolUseContentBlock(block)) {
        const { toolUseId, name, input } = block.toolUse;
        messages.push({
          id: `toolcall-${toolUseId}`,
          role: "assistant",
          toolCallId: toolUseId,
          toolCallName: name,
          toolCallArgs: input ?? {},
          ...withCreatedAt,
        });
        return;
      }

      if (event.role === "user" && isToolResultContentBlock(block)) {
        const { toolUseId, content } = block.toolResult;
        messages.push({
          id: `toolresult-${toolUseId}`,
          role: "tool",
          toolCallId: toolUseId,
          content: stringifyToolResultContent(content),
          ...withCreatedAt,
        });
        return;
      }

      // 想定外の形状のコンテンツブロックは安全に無視する（Requirements 2.7）。
    });
  });

  return messages;
}
