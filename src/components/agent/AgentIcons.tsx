"use client";

/**
 * AgentIcons — 共有のインライン SVG アイコン（プレゼンテーション専用）
 *
 * ブランドマーク（page.tsx）とアバター（FeedbackAssistantMessage /
 * ChatUserMessage）で再利用する軽量なストロークアイコン。色は `currentColor`
 * で描画し、表示色は呼び出し側の CSS（`color`）で制御する。サイズは親コンテナ
 * いっぱい（width/height 100%）に追従し、親側の padding で内接させる。
 *
 * いずれも装飾用のため `aria-hidden`。役割は著者名テキスト（「アシスタント」/
 * 「あなた」）やブランドタイトルが伝えるため、アイコン自体はラベルを持たない。
 *
 * 依存追加なし（インライン SVG のみ）。lucide の "Bot" / "User" を参考にした
 * ミニマルなグリフで、~18〜34px でも視認できるよう線幅・丸めを調整している。
 */

interface AgentIconProps {
  /** 追加のクラス名（任意） */
  className?: string;
}

/**
 * BotIcon — フレンドリーな「ボット」グリフ（lucide "Bot" 風）。
 * 角丸の頭部・2 つの目・上部の小さなアンテナで構成する。ストロークベース、
 * `currentColor`。ブランドマークとアシスタントアバターで共有する。
 */
export function BotIcon({ className }: AgentIconProps) {
  return (
    <svg
      className={className}
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* アンテナ */}
      <path d="M12 4V2" />
      <circle cx="12" cy="4" r="0.6" fill="currentColor" stroke="none" />
      {/* 頭部（角丸の筐体） */}
      <rect x="4" y="7" width="16" height="12" rx="3" />
      {/* サイドの耳 */}
      <path d="M2 12v3" />
      <path d="M22 12v3" />
      {/* 目 */}
      <circle cx="9" cy="13" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * UserIcon — 人物グリフ（lucide "User" 風）。頭部の円 + 肩のアーク。
 * ストロークベース、`currentColor`。ユーザーアバターで使用する。
 */
export function UserIcon({ className }: AgentIconProps) {
  return (
    <svg
      className={className}
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* 頭部 */}
      <circle cx="12" cy="8" r="4" />
      {/* 肩のアーク */}
      <path d="M4 20c0-3.87 3.58-7 8-7s8 3.13 8 7" />
    </svg>
  );
}
