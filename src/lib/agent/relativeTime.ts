/**
 * 相対時刻フォーマットユーティリティ
 *
 * タイムスタンプを人間が読みやすい相対時刻文字列に変換する純粋関数。
 * テスト容易性のため、基準時刻を引数で受け取れるようにしている。
 *
 * Requirements: 3.2
 */

/**
 * ISO 8601 タイムスタンプを相対時刻文字列にフォーマットする。
 *
 * バケット分類:
 * - 1分未満: 「今」
 * - 1時間未満: 「N分前」
 * - 24時間未満: 「N時間前」
 * - 24〜48時間: 「昨日」
 * - 48時間〜7日: 「N日前」
 * - それ以外: 日付文字列（例: 2025/01/15）
 *
 * @param timestamp - ISO 8601 形式のタイムスタンプ文字列
 * @param now - 基準時刻（デフォルト: 現在時刻）
 * @returns 相対時刻を表す日本語文字列
 */
export function formatRelativeTime(timestamp: string, now?: Date): string {
  const baseTime = now ?? new Date();
  const targetTime = new Date(timestamp);

  const diffMs = baseTime.getTime() - targetTime.getTime();

  // 未来のタイムスタンプや無効な差分の場合は日付文字列を返す
  if (diffMs < 0) {
    return formatDateString(targetTime);
  }

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // 1分未満
  if (diffMinutes < 1) {
    return "今";
  }

  // 1時間未満
  if (diffHours < 1) {
    return `${diffMinutes}分前`;
  }

  // 24時間未満
  if (diffHours < 24) {
    return `${diffHours}時間前`;
  }

  // 24〜48時間
  if (diffHours < 48) {
    return "昨日";
  }

  // 48時間〜7日
  if (diffDays <= 7) {
    return `${diffDays}日前`;
  }

  // それ以外: 日付文字列
  return formatDateString(targetTime);
}

/**
 * Date を YYYY/MM/DD 形式の文字列にフォーマットする。
 */
function formatDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}
