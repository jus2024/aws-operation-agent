/**
 * 既存 Connection の選択可否ゲート
 *
 * 移行前に作成された既存 Connection レコードは、`awsProfileName` が
 * 未設定（null/undefined）または空白のみの値を持つ可能性がある
 * （Requirement 8.2）。そのような Connection は新規セッション開始時の
 * 選択対象として提示してはならない。
 *
 * この判定は純粋関数として分離し、UI コンポーネント
 * （`src/components/agent/ProfileSelector.tsx`）から利用する。
 *
 * Requirements: 8.2
 */

/**
 * Connection が新規セッション開始時に選択可能かどうかを判定する。
 *
 * `awsProfileName` が存在し、かつトリム後に空でない場合のみ `true` を返す。
 * - `null` / `undefined` → 選択不可
 * - 空文字列 `""` → 選択不可
 * - 空白のみ（例: `"   "`） → 選択不可
 * - 非空文字列（前後に空白を含んでいてもよい） → 選択可
 *
 * @param awsProfileName - Connection の awsProfileName フィールドの値
 */
export function isConnectionSelectable(
  awsProfileName: string | null | undefined,
): boolean {
  if (!awsProfileName) {
    return false;
  }

  return awsProfileName.trim().length > 0;
}
