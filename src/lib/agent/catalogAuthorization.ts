/**
 * カタログ認可決定ロジック
 *
 * Connection モデルに対する操作の認可を判定する純粋関数。
 * Amplify Data の認可ルールを反映:
 * - ADMINS グループ: create/update/delete/read すべて許可
 * - 認証済みユーザー（非管理者）: read のみ許可
 * - 未認証ユーザー: すべて拒否
 *
 * Requirements: 3.4, 6.3, 9.3, 9.4
 */

/** Connection に対する操作種別 */
export type ConnectionOperation = "read" | "create" | "update" | "delete";

/** 認証状態 */
export interface AuthContext {
  /** ユーザーが認証済みかどうか */
  isAuthenticated: boolean;
  /** ユーザーが所属するグループの集合 */
  groups: string[];
}

/**
 * Connection モデルに対する操作が許可されるかを判定する。
 *
 * ルール:
 * - 未認証 → すべて拒否
 * - 認証済み + ADMINS グループ → すべて許可 (read/create/update/delete)
 * - 認証済み + 非 ADMINS → read のみ許可、write (create/update/delete) は拒否
 */
export function canPerformOperation(
  auth: AuthContext,
  operation: ConnectionOperation
): boolean {
  // 未認証ユーザーはすべて拒否
  if (!auth.isAuthenticated) {
    return false;
  }

  // read は認証済みであれば誰でも許可
  if (operation === "read") {
    return true;
  }

  // write 操作 (create/update/delete) は ADMINS グループのみ
  return auth.groups.includes("ADMINS");
}
