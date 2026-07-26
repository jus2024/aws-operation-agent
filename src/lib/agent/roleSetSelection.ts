import type { RoleInfo } from "@/src/lib/agent/roleInfo";

/**
 * Role_Set 選択の純粋ロジック
 *
 * `RoleSetSelectorDialog` の選択状態管理・確定判定・ダイアログ表示可否を
 * 純粋関数として切り出す（`copilotProperties.ts` / `accessGates.ts` と同じ
 * 「UI ロジックを純粋関数に切り出す」パターンを踏襲）。
 * React hooks や API コールに依存しない。
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5, 2.7
 */

/**
 * 指定した Role_Name の選択状態を反転した新しい `Set` を返す。
 *
 * 既存の `selected` は変更しない（新しい `Set` を返す）。
 * 選択済みなら除外し、未選択なら追加する。
 *
 * Requirements: 2.2, 2.3
 */
export function toggleRoleSelection(
  selected: Set<string>,
  roleName: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(roleName)) {
    next.delete(roleName);
  } else {
    next.add(roleName);
  }
  return next;
}

/**
 * 選択が非空のときのみ「開始」ボタンを押せる（true を返す）。
 *
 * Requirements: 2.5
 */
export function canConfirmRoleSet(selectedRoleNames: string[]): boolean {
  return selectedRoleNames.length > 0;
}

/**
 * 確定操作から Chat_Session 作成ペイロードを構築する。
 * 選択が0件の場合は null を返し、呼び出し元は Chat_Session を作成しない
 * （バイパス手段の有無を問わず、Requirement 2.5 の "SHALL NOT create a
 * Chat_Session with a Role_Set containing zero Role_Entry records under
 * any circumstance" を満たす）。
 *
 * Requirements: 2.4, 2.5
 */
export function buildRoleSetConfirmPayload(
  selectedRoleNames: string[],
): { roleNames: string[] } | null {
  if (selectedRoleNames.length === 0) return null;
  return { roleNames: [...selectedRoleNames] };
}

/**
 * Role_Set_Selector を開いてよいかを判定する。
 * `roles` が `null` または空配列のときは false を返す
 * （Role_Config が空、または取得に失敗した状態）。
 *
 * Requirements: 2.7
 */
export function canOpenRoleSetSelector(roles: RoleInfo[] | null): boolean {
  return roles !== null && roles.length > 0;
}
