/**
 * セッション名の解決・生成ロジック（純粋関数モジュール）
 *
 * - defaultSessionName(): 新規セッション作成時の初期名を返す
 * - generateSessionName(): 最初のユーザーメッセージからセッション名を生成する
 * - resolveSessionName(): ユーザー入力または生成名を確定値へ解決する
 *
 * Requirements: 1.3, 4.1, 4.3, 4.4, 5.3, 5.4
 */

/** セッション名のデフォルト値 */
export const DEFAULT_SESSION_NAME = "新しいチャット";

/** セッション名の最大長（ユーザー入力・保存時） */
export const MAX_SESSION_NAME_LENGTH = 100;

/** 自動生成セッション名の最大長 */
export const MAX_GENERATED_NAME_LENGTH = 30;

/**
 * 新規セッション作成時の初期名を返す（Requirements 4.3）
 */
export function defaultSessionName(): string {
  return DEFAULT_SESSION_NAME;
}

/**
 * 最初のユーザーメッセージからセッション名を生成する（Requirements 4.1, 4.4）
 *
 * - メッセージをトリムし、先頭30文字以内で切り詰める
 * - 空文字列または空白のみの入力に対してはデフォルト名を返す
 */
export function generateSessionName(messageText: string): string {
  const trimmed = messageText.trim();
  if (trimmed.length === 0) {
    return defaultSessionName();
  }
  return trimmed.slice(0, MAX_GENERATED_NAME_LENGTH);
}

/**
 * ユーザー入力または生成名を確定値へ解決する（Requirements 1.3, 5.3, 5.4）
 *
 * - candidate が空文字列または空白のみ → previous を返す（編集を拒否）
 * - candidate が100文字超 → 先頭100文字に切り詰めて返す
 * - それ以外 → candidate をそのまま返す
 */
export function resolveSessionName(candidate: string, previous: string): string {
  const trimmedCandidate = candidate.trim();
  if (trimmedCandidate.length === 0) {
    return previous;
  }
  if (candidate.length > MAX_SESSION_NAME_LENGTH) {
    return candidate.slice(0, MAX_SESSION_NAME_LENGTH);
  }
  return candidate;
}

/**
 * 新規セッション作成時に、任意入力されたセッション名を確定値へ解決する。
 *
 * - candidate が未指定 / 空文字列 / 空白のみ → defaultSessionName()（"新しいチャット"）
 *   を返す（最初のユーザーメッセージ送信時に generateSessionName で自動生成される、
 *   既存の挙動をそのまま維持する）
 * - それ以外 → 前後の空白を取り除いた上で、100文字超は先頭100文字に切り詰めて返す
 */
export function resolveInitialSessionName(candidate: string | undefined | null): string {
  const trimmed = candidate?.trim() ?? "";
  if (trimmed.length === 0) {
    return defaultSessionName();
  }
  return trimmed.slice(0, MAX_SESSION_NAME_LENGTH);
}
