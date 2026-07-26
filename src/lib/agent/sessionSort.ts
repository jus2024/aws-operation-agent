/**
 * セッション・メッセージのソートおよび選択ユーティリティ
 *
 * 純粋関数として実装し、入力配列を変更せず新しい配列を返す。
 * ジェネリック型制約により、必要最小限のフィールドのみ要求する。
 *
 * Requirements: 2.4, 3.3, 7.2, 7.3, 7.4
 */

/**
 * セッション一覧を updatedAt の降順（新しい順）にソートする。
 * 入力配列は変更せず、新しい配列を返す。
 *
 * @param sessions - updatedAt フィールドを持つセッションのリスト
 * @returns updatedAt 降順でソートされた新しい配列
 */
export function sortSessionsByUpdatedAtDesc<T extends { updatedAt: string }>(
  sessions: T[],
): T[] {
  return [...sessions].sort((a, b) => {
    if (a.updatedAt > b.updatedAt) return -1;
    if (a.updatedAt < b.updatedAt) return 1;
    return 0;
  });
}

/**
 * 残存セッションから updatedAt が最大（最も新しい）のセッションを選択する。
 * リストが空の場合は null を返す。
 *
 * @param remaining - id と updatedAt フィールドを持つセッションのリスト
 * @returns updatedAt が最大のセッション、またはリストが空の場合は null
 */
export function selectNextActiveSession<T extends { id: string; updatedAt: string }>(
  remaining: T[],
): T | null {
  if (remaining.length === 0) {
    return null;
  }

  let maxSession = remaining[0];
  for (let i = 1; i < remaining.length; i++) {
    if (remaining[i].updatedAt > maxSession.updatedAt) {
      maxSession = remaining[i];
    }
  }
  return maxSession;
}
