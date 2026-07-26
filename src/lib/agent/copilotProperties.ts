/**
 * CopilotKit properties 構築の純粋ロジック
 *
 * roleNames（選択された Role_Set の Role_Name 配列）から、
 * CopilotKit の `properties` として送信するオブジェクトを構築する。
 * 非空配列のときのみキーを含め、空/未指定なら undefined を返す。
 *
 * connectionId / awsProfileName は Connection カタログ廃止に伴い削除済み。
 * operationScope はロール単位で Agent 側が解決するため送出しない。
 *
 * Requirements: 2.6
 */

/**
 * roleNames から CopilotKit の properties オブジェクトを構築する。
 *
 * - roleNames が非空配列であれば `{ roleNames: [...roleNames] }` を返す
 * - roleNames が未指定または空配列であれば undefined を返す
 *   （CopilotKit の properties は空オブジェクトではなく undefined を期待する）
 *
 * @param roleNames - 選択された Role_Set の Role_Name 配列
 */
export function buildCopilotProperties(
  roleNames: string[] | undefined,
): { roleNames: string[] } | undefined {
  if (!roleNames || roleNames.length === 0) return undefined;
  return { roleNames: [...roleNames] };
}
