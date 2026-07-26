/**
 * 過去セッション復元の解決ロジック
 *
 * サイドバーで過去の Chat_Session が選択された際、そのセッションに記録された
 * `roleNames`（Role_Set）を、現在の Role_Config（`useRoles()` が
 * `GET /api/roles` から取得しメモリ上に保持している `RoleInfo[]`）に対して
 * ローカルに照合する純粋関数を提供する。
 *
 * role-set-switching により、セッションに記録されるロールは単一の
 * `roleName` から複数の `roleNames`（Role_Set）に一般化された。過去
 * セッションの復元は「保存された各 roleName が現在の Role_Config に
 * 存在するか」というローカルな配列検索のみで完結し、追加の DB ルックアップ
 * や API 呼び出しを必要としない（Role_Config は呼び出し元がすでに
 * メモリ上に持っているため）。そのため本関数は同期的・純粋な関数として
 * 実装する。
 *
 * 分類ルール:
 * - `storedRoleNames` の各要素が `availableRoles` 内に存在する →
 *   `available`（Requirement 3.4 — 現在の Role_Config に存在する
 *   Role_Entry として、表示・以後のチャットリクエストへの送信に使う）
 * - 存在しない → `unavailableNames`
 *   （Requirement 3.5, 3.6 — 一部/全部が欠落している場合の
 *   インジケーター表示、および全欠落時の送信ブロックに使う）
 *
 * `/api/roles`（Component 5）は `isActive = true` のレコードのみを返す
 * ため、`availableRoles` には論理削除済み（`isActive = false`）の
 * Role_Entry は最初から含まれない。したがって「Role_Config に存在するが
 * `isActive` が false」の Role_Name と「Role_Config に存在しない」
 * Role_Name は、本関数にとって区別不要であり、どちらも同一に
 * `unavailableNames` へ振り分けられる（Requirement 3.5/3.6 の
 * "A Role_Name whose corresponding Role_Entry ... has an Is_Active value
 * of false SHALL be treated identically to a Role_Name that does not
 * exist" を、`/api/roles` の isActive フィルタリングとの組み合わせで
 * 自動的に満たす）。
 *
 * ローカル配列検索はネットワークエラーを起こしえないため、旧実装にあった
 * `lookup_error`（ネットワーク/サーバーエラー）のケースは廃止済みのまま
 * 変更しない。
 *
 * Requirements: 3.4, 3.5, 3.6
 */

import type { RoleInfo } from "@/src/lib/agent/roleInfo";

// --- Types ---

/**
 * 過去セッション復元の Role_Set 解決結果
 *
 * - `available`: `storedRoleNames` のうち現在の Role_Config に存在する
 *   Role_Entry（`RoleInfo`）を、保存順のまま抽出したもの。表示・
 *   ヘッダー構築・以後のチャットリクエストへの送信に使う。
 * - `unavailableNames`: `storedRoleNames` のうち現在の Role_Config に
 *   存在しない Role_Name（ロール設定の変更・論理削除等）を、保存順の
 *   まま抽出したもの。欠落インジケーター表示用（Requirement 3.5）。
 */
export interface RoleSetRestoreResult {
  /** 現在の Role_Config に存在する Role_Entry（表示・送信に使う有効な Role_Set） */
  available: RoleInfo[];
  /** 現在の Role_Config に存在しない Role_Name（欠落インジケーター表示用） */
  unavailableNames: string[];
}

// --- Pure Functions ---

/**
 * 過去 Chat_Session に記録された `storedRoleNames`（Role_Set）から、
 * 現在の Role_Config に対する復元結果を解決する。
 *
 * `availableRoles` は呼び出し側（`useRoles()` を使用する page.tsx 等）が
 * すでにメモリ上に持っている現在の Role_Config のスナップショットであり、
 * この関数自体は API 呼び出しやデータクライアントに依存しない
 * 同期的な純粋関数として実装する（Property 9 の PBT で任意の
 * `availableRoles` を注入できるようにするため）。
 *
 * `storedRoleNames` 自体は変更しない（Data_Model 側の永続値は不変の
 * まま、Requirement 3.5 の "SHALL NOT modify the Role_Names persisted"）。
 *
 * @param storedRoleNames - 過去 Chat_Session に記録された roleNames。
 * @param availableRoles - 現在の Role_Config から取得済みの `RoleInfo[]`。
 */
export function resolveRestoredRoleSet(
  storedRoleNames: string[],
  availableRoles: RoleInfo[],
): RoleSetRestoreResult {
  const byName = new Map(availableRoles.map((r) => [r.name, r]));
  const available: RoleInfo[] = [];
  const unavailableNames: string[] = [];

  for (const name of storedRoleNames) {
    const match = byName.get(name);
    if (match) {
      available.push(match);
    } else {
      unavailableNames.push(name);
    }
  }

  return { available, unavailableNames };
}

/**
 * 復元結果から送信可否を判定する。
 *
 * 有効な Role_Entry（`available`）が1件以上あれば送信可能とする
 * （Requirement 3.6 — 有効な Role_Entry が0件なら送信不可）。
 * 一部のみ欠落している場合（`unavailableNames.length > 0` かつ
 * `available.length > 0`）は部分欠落インジケーターを表示しつつ
 * 送信は許可する（Requirement 3.5）。
 */
export function canSendInRestoredSession(result: RoleSetRestoreResult): boolean {
  return result.available.length > 0;
}
