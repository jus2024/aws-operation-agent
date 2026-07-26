/**
 * アクセスゲート純粋関数
 *
 * チャット描画可否、管理 UI 描画可否、セッション-接続束縛の不変性を
 * 純粋関数 / リデューサとして実装する。
 * React hooks や API コールに依存しない。
 *
 * Requirements: 4.1, 4.4, 8.1, 8.5, 8.6, 8.7, 9.5
 */

export interface ChatAccessState {
  isAuthenticated: boolean;
  catalogCount: number;
  selectedConnectionId: string | null;
}

/**
 * チャット UI を描画/有効化してよいかを判定する。
 * 以下の 3 条件がすべて成立する場合のみ true を返す:
 *   1. ユーザーが認証済みである
 *   2. 接続カタログに 1 件以上のエントリがある
 *   3. 接続が選択されている（selectedConnectionId が非 null かつ非空文字列）
 *
 * Requirements: 4.1, 8.1, 8.5
 */
export function canAccessChat(state: ChatAccessState): boolean {
  return (
    state.isAuthenticated &&
    state.catalogCount >= 1 &&
    state.selectedConnectionId !== null &&
    state.selectedConnectionId !== ""
  );
}

/**
 * 管理コントロール（接続の作成/編集/削除）を描画してよいかを判定する。
 * groups 配列に "ADMINS" が含まれる場合のみ true を返す。
 *
 * Requirements: 8.6, 8.7, 9.5
 */
export function canAccessAdminControls(groups: string[]): boolean {
  return groups.includes("ADMINS");
}

/**
 * Role_Config メンテナンス画面（RoleConfigManager）へのアクセス可否を判定する。
 * groups 配列に "ADMINS" が含まれる場合のみ true を返す。
 *
 * Requirements: 8.1
 */
export function canAccessRoleConfigSettings(groups: string[]): boolean {
  return groups.includes("ADMINS");
}

/**
 * Feedback_Dashboard（フィードバック集計画面）へのアクセス可否を判定する。
 * 認証済みユーザーであれば全員アクセスできる（グループ制限なし）。
 * RoleConfig の ADMINS ゲートとは異なり、全認証ユーザーへ開放する。
 *
 * Requirements: 5.1, 8.6
 */
export function canAccessFeedbackDashboard(isAuthenticated: boolean): boolean {
  return isAuthenticated;
}

export interface SessionState {
  activeSessionId: string | null;
  boundConnectionId: string | null;
}

/**
 * セッション中の接続変更を試みる。
 * - セッションがアクティブ（activeSessionId が非 null）の場合、接続は変更できない
 *   → 現在の状態をそのまま返す（不変性の保証）
 * - セッションが非アクティブ（activeSessionId が null）の場合、接続を更新できる
 *   → boundConnectionId を newConnectionId に更新した新しい状態を返す
 *
 * Requirements: 4.4
 */
export function attemptConnectionChange(
  state: SessionState,
  newConnectionId: string,
): SessionState {
  if (state.activeSessionId !== null) {
    // セッションがアクティブな間は接続を変更できない
    return state;
  }

  return {
    ...state,
    boundConnectionId: newConnectionId,
  };
}
