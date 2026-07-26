/**
 * 認証ゲート: Bearer トークン抽出と認証判定の純粋関数。
 *
 * route.ts の extractBearerToken ロジックを純粋関数として切り出し、
 * プロパティテストを可能にする。
 *
 * Requirements: 7.5, 9.2
 */

/**
 * Authorization ヘッダー値から Bearer トークンを抽出する。
 *
 * - ヘッダーが null → null
 * - "Bearer " プレフィックスがない → null
 * - "Bearer " の後が空（トリム後）→ null
 * - "Bearer " の後に非空トークンがある → トークン文字列を返す
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (authHeader === null) {
    return null;
  }
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Authorization ヘッダーから認証済みかどうかを判定する。
 *
 * extractBearerToken が non-null を返す場合に true。
 */
export function isAuthenticated(authHeader: string | null): boolean {
  return extractBearerToken(authHeader) !== null;
}
