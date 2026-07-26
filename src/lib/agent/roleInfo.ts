/**
 * RoleInfo 型と DynamoDB Scan 結果からの変換ロジック
 *
 * Next.js の Route Handler（`src/app/api/roles/route.ts`）は HTTP メソッド名
 * （GET/POST 等）や `dynamic` などの決められたエクスポートしか許可しない
 * （それ以外の named export があるとビルド時に
 * "... is not a valid Route export field" エラーになる）。
 * そのため `RoleInfo` 型と `toRoleInfoList` はこのモジュールに切り出し、
 * route.ts およびフロントエンドの各モジュールから import する。
 *
 * Requirements: 1.6, 1.7, 1.8
 */

export interface RoleInfo {
  name: string;
  displayName: string;
  accountLabel: string;
  scope: "readonly" | "readwrite" | "admin";
}

const VALID_SCOPES = new Set<RoleInfo["scope"]>(["readonly", "readwrite", "admin"]);

/**
 * DynamoDB `Scan` の生アイテム（dict）を `RoleInfo[]` に変換する。
 *
 * - `name` / `displayName` / `accountLabel` が非空文字列、`scope` が
 *   readonly/readwrite/admin のいずれかであることを検証する。不正なアイテムは
 *   スキップし、有効なアイテムのみを返す（`AGENT_ROLES` 時代の
 *   `parseRolesFromEnv` と同じ「有効な分だけ返す」方針を継続）。
 * - `roleArn` は入力に含まれていても `RoleInfo` に存在しないフィールドのため、
 *   構造上コピーされない（Requirements 1.6）。
 *
 * 例外を投げない。呼び出し側は常に配列を受け取る。
 */
export function toRoleInfoList(items: Record<string, unknown>[]): RoleInfo[] {
  const roles: RoleInfo[] = [];
  for (const item of items) {
    const { name, displayName, accountLabel, scope } = item;
    if (typeof name !== "string" || name.trim().length === 0) {
      continue;
    }
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      continue;
    }
    if (typeof accountLabel !== "string" || accountLabel.trim().length === 0) {
      continue;
    }
    if (typeof scope !== "string" || !VALID_SCOPES.has(scope as RoleInfo["scope"])) {
      continue;
    }
    roles.push({ name, displayName, accountLabel, scope: scope as RoleInfo["scope"] });
  }
  return roles;
}
