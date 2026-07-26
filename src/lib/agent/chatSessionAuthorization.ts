/**
 * ChatSession owner 認可ロジック
 *
 * ChatSession モデルに対する owner ベース認可を判定する純粋関数。
 * Amplify Data の `allow.owner()` ルールを反映:
 * - ChatSession の ownerUserId と一致する Cognito sub を持つユーザーのみ CRUD 可能
 * - 他のユーザーはアクセス拒否
 *
 * Requirements: 6.4
 */

/**
 * ChatSession に対するアクセスが許可されるかを判定する。
 *
 * Amplify Data の `allow.owner()` は Cognito の `sub` クレームを所有者フィールド
 * (ownerUserId) と照合し、一致する場合のみ CRUD を許可する。
 *
 * @param requestUserId - リクエストを行っているユーザーの Cognito sub
 * @param sessionOwnerUserId - ChatSession の ownerUserId フィールド
 * @returns アクセスが許可される場合 true、拒否される場合 false
 */
export function canAccessChatSession(
  requestUserId: string,
  sessionOwnerUserId: string
): boolean {
  return requestUserId === sessionOwnerUserId;
}
