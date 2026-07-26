/**
 * 画像添付の純粋バリデーションロジック（インフラ非依存・全域関数）
 *
 * `accessGates.ts` / `feedbackState.ts` と同じ
 * 「UI ロジックを純粋関数に切り出す」パターンを踏襲する。
 * React hooks や API コール（CopilotKit / AG-UI / Amplify Data）に依存しない。
 *
 * すべての検証関数は例外を投げず、`ok/reason` の総和型を返す（全域関数）。
 * UI コンポーネント（Composer）はこれらを呼び出すだけとし、
 * 型許可外・サイズ超過・合計予算超過・枚数超過を非ブロッキングに拒否表示する。
 *
 * Requirements: 9.4, 9.5, 9.8
 */

// --- 画像上限（確定・保守的な値）---------------------------------------------
// 根拠: Amplify SSR Lambda のリクエストペイロードは約 6MB が上限。base64 化で
// 生バイトは約 1.33 倍に膨らみ、さらに JSON エンベロープ・テキスト・メッセージ
// 履歴のオーバーヘッドが乗る。加えて Bedrock Converse は 1 画像あたり ≤3.75MB。
// これらを踏まえ、生バイトで保守的に「1 画像 3MB / 1 メッセージ合計 3MB / 3 枚」
// を採用する。1 メッセージ合計予算（MESSAGE_IMAGE_BUDGET_BYTES）が主要なゲート。

/** 単一画像の生バイト上限（3MB, Req 9.5(a)） */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 主要ゲート: 1 メッセージの添付画像の生バイト合計上限（3MB, Req 9.5(b)）。
 */
export const MESSAGE_IMAGE_BUDGET_BYTES = 3 * 1024 * 1024;

/** 1 メッセージあたり最大 3 枚（Req 9.5(c)） */
export const IMAGE_MAX_COUNT = 3;

/**
 * AG-UI 経路（Amplify SSR Lambda + API Gateway）の概算ペイロード上限（Req 9.8）。
 * リクエスト全体は約 6MB を上限とする。
 */
export const TRANSPORT_MAX_BYTES = 6 * 1024 * 1024;

/**
 * base64 判定に用いる実効ペイロード上限（約 5MB）。
 * エンベロープ/テキスト/base64 膨張（約 1.33x）を差し引いた usable ceiling。
 */
export const EFFECTIVE_TRANSPORT_MAX_BYTES = 5 * 1024 * 1024;

/** 受理する画像 MIME タイプの許可リスト（Req 9.4） */
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/**
 * 送信前の画像添付。base64 データは送信直前に付与する
 * （検証はメタデータで行うため dataBase64 は未設定でよい）。
 */
export interface ImageAttachment {
  id: string;
  filename: string;
  /** 例: "image/png" */
  contentType: string;
  sizeBytes: number;
  /** 送信時に設定。検証時は未設定でよい */
  dataBase64?: string;
}

/**
 * 拒否理由（総和型）。UI はこれを非ブロッキングなメッセージへマップする。
 */
export type ImageAttachmentError =
  /** 許可外の MIME タイプ（Req 9.4） */
  | "unsupported_type"
  /** 単一画像が 3MB 超過（Req 9.5(a)） */
  | "file_too_large"
  /** 1 メッセージの生バイト合計が 3MB 超過（Req 9.5(b)） */
  | "message_budget_exceeded"
  /** 1 メッセージあたり 3 枚超過（Req 9.5(c)） */
  | "too_many"
  /** base64 化失敗（Req 9.8） */
  | "encode_failed"
  /** 合計 base64 ペイロードが転送上限超過（Req 9.8） */
  | "payload_too_large";

/**
 * 検証に必要な最小限のファイルメタ（File 全体に依存しない＝テスト容易）。
 */
export interface ImageFileMeta {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * 検証結果（総和型）。例外は投げない＝全域関数。
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: ImageAttachmentError };

/**
 * 単一ファイルの受理可否（純粋・全域）。
 *
 * 型が `ACCEPTED_IMAGE_TYPES` に含まれ、かつ `sizeBytes <= IMAGE_MAX_BYTES`（3MB）の
 * ときだけ accept する（Req 9.4, 9.5(a)）。
 *   - 型が許可外なら `unsupported_type`
 *   - 型は許可だがサイズ超過なら `file_too_large`
 * 境界値 `sizeBytes === IMAGE_MAX_BYTES` は有効、`+1` は無効。
 *
 * Requirements: 9.4, 9.5
 */
export function validateImageFile(meta: ImageFileMeta): ValidationResult {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(meta.contentType)) {
    return { ok: false, reason: "unsupported_type" };
  }
  if (meta.sizeBytes > IMAGE_MAX_BYTES) {
    return { ok: false, reason: "file_too_large" };
  }
  return { ok: true };
}

/**
 * 【主要ゲート】1 メッセージの添付画像の生バイト合計が予算内かの純粋述語（Req 9.5(b)）。
 *
 * `sum(rawByteSizes) <= MESSAGE_IMAGE_BUDGET_BYTES`（3MB）のときだけ accept。
 * 超過時は `message_budget_exceeded` を理由に `ok: false`（例外は投げない＝全域）。
 * 境界値 `sum === MESSAGE_IMAGE_BUDGET_BYTES` は有効、`+1` は無効。空配列は合計 0 で有効。
 *
 * Requirements: 9.5
 */
export function withinMessageBudget(rawByteSizes: number[]): ValidationResult {
  const total = rawByteSizes.reduce((sum, size) => sum + size, 0);
  if (total > MESSAGE_IMAGE_BUDGET_BYTES) {
    return { ok: false, reason: "message_budget_exceeded" };
  }
  return { ok: true };
}

/**
 * 現在の添付数に対して incoming 枚を追加できるか（純粋・全域）。
 *
 * `currentCount + incoming <= IMAGE_MAX_COUNT`（3）のときだけ accept する（Req 9.5(c)）。
 * 超過時は `too_many` を理由に `ok: false`。
 * 境界値 `currentCount + incoming === IMAGE_MAX_COUNT` は有効、`+1` は無効。
 *
 * Requirements: 9.5
 */
export function canAcceptMore(
  currentCount: number,
  incoming: number,
): ValidationResult {
  if (currentCount + incoming > IMAGE_MAX_COUNT) {
    return { ok: false, reason: "too_many" };
  }
  return { ok: true };
}

/**
 * 合計 base64 ペイロードが実効転送上限内かの純粋述語（Req 9.8）。
 *
 * `sum(base64ByteSizes) <= EFFECTIVE_TRANSPORT_MAX_BYTES`（約 5MB）のときだけ accept。
 * 超過時は `payload_too_large` を理由に `ok: false`（エラー表面化の判定に使用）。
 * 境界値 `sum === EFFECTIVE_TRANSPORT_MAX_BYTES` は有効、`+1` は無効。
 *
 * Requirements: 9.8
 */
export function withinTransportLimit(base64ByteSizes: number[]): ValidationResult {
  const total = base64ByteSizes.reduce((sum, size) => sum + size, 0);
  if (total > EFFECTIVE_TRANSPORT_MAX_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  return { ok: true };
}
