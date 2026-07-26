/**
 * チャットセッション作成ペイロード構築（純粋関数モジュール）
 *
 * - buildChatSessionCreateInput(): ChatSession.create() へ渡す入力を構築する
 *
 * Requirements: 3.2
 */

import { resolveInitialSessionName } from "./sessionNameResolver";

/**
 * ChatSession.create() へ渡す入力を構築する（Requirements 3.2）
 *
 * ownerUserId, roleNames をそのまま含み（operationScope は含まない）。
 * sessionName は params.sessionName（新規チャット作成時にユーザーが任意入力した
 * セッション名）を resolveInitialSessionName() で解決した値を使用する。
 * 未指定・空欄の場合は defaultSessionName()（"新しいチャット"）にフォールバックし、
 * 最初のユーザーメッセージ送信時に generateSessionName で自動生成される既存の
 * 挙動を維持する。startedAt・updatedAt に現在時刻の ISO 文字列を付与する。
 */
export function buildChatSessionCreateInput(params: {
  ownerUserId: string;
  roleNames: string[];
  sessionName?: string;
}): {
  ownerUserId: string;
  roleNames: string[];
  sessionName: string;
  startedAt: string;
  updatedAt: string;
} {
  const now = new Date().toISOString();
  return {
    ownerUserId: params.ownerUserId,
    roleNames: params.roleNames,
    sessionName: resolveInitialSessionName(params.sessionName),
    startedAt: now,
    updatedAt: now,
  };
}
