/**
 * メッセージ時刻フォーマットユーティリティ
 *
 * メッセージの記録/初回表示時刻（epoch ミリ秒）を、ローカルタイムゾーンの
 * 24 時間表記 `HH:MM`（ゼロ埋め）へ変換する純粋関数。チャットの各メッセージ行
 * （`.msg__meta` の `.msg__time`）に著者名の隣で表示するために使う。
 *
 * - 無効な入力（`NaN`/`Infinity`/非数値、無効な日時）に対しては空文字列 `""` を返す。
 *   呼び出し側は空文字列のときは何も描画しない（時刻を捏造しない）。
 * - `relativeTime.ts`（サイドバーの相対時刻）とは用途が異なるため別モジュールに分ける
 *   （こちらは「その日の時刻」を常に絶対表記で出す）。
 */
export function formatMessageTime(epochMs: number): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    return "";
  }
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * メッセージの記録/初回表示時刻（epoch ミリ秒）を、ローカルタイムゾーンの
 * 日本語日付表記 `YYYY年M月D日（曜）` へ変換する純粋関数。チャットの
 * 日付区切り行（`.chat-day-divider`）に表示するために使う。
 *
 * - 曜日は 1 文字表記（日月火水木金土）を用いる。
 * - 月・日はゼロ埋めしない（`M`/`D`）。
 * - 日付の各要素はローカルタイム（UTC ではない）から算出する。これは
 *   `formatMessageTime` の HH:MM と同じ暦日境界に揃えるため。
 * - 無効な入力（`NaN`/`Infinity`/非数値、無効な日時）に対しては空文字列 `""` を
 *   返す。呼び出し側は空文字列のときは何も描画しない（日付を捏造しない）。
 */
export function formatMessageDate(epochMs: number): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    return "";
  }
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekday = weekdays[date.getDay()];
  return `${year}年${month}月${day}日（${weekday}）`;
}

/**
 * epoch ミリ秒を、ローカルタイムゾーンの暦日キー `YYYY-MM-DD`（ゼロ埋め）へ
 * 変換する純粋関数。日付区切り行の境界判定（連続メッセージ間で暦日が変わったか）に
 * 使う。`formatMessageDate` / `formatMessageTime` と同じローカル暦日基準に揃える。
 *
 * 無効な入力（`NaN`/`Infinity`/非数値、無効な日時）には空文字列 `""` を返す。
 * 呼び出し側は空文字列を「日付キー無し」として扱い、日付区切りの起点にしない。
 */
export function toLocalDayKey(epochMs: number): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    return "";
  }
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
