"use client";

/**
 * SessionHeader — セッション固定ヘッダーコンポーネント
 *
 * アクティブなチャットセッションで選択された Role_Set（複数の Role_Entry）を
 * スクロールなしで見える固定ヘッダーに、ロールごとのチップとして表示する。
 * 各チップは displayName + Account_Label をラベルとし、既存の SCOPE_COLORS
 * 配色を再利用した操作スコープバッジを併せて表示する。
 *
 * `missing: true` のチップは、過去セッションが参照していた Role_Entry が
 * 現在の Role_Config に見つからなかったことを示す欠落インジケーターを、
 * 個別チップ単位で表示する（Requirement 3.5, 3.6）。
 *
 * 新規 Chat_Session 開始は、サイドバーの「新規チャット」に一本化する。ヘッダー
 * 側の冗長な「新規セッション」ボタンは撤去した（Requirement 7.5, Task 6.6）。
 *
 * Requirements: 3.5, 3.6, 7.5
 */

export interface RoleChip {
  name: string;
  displayName: string;
  accountLabel: string;
  scope: string;
  /** true の場合、このロールが現在の Role_Config に見つからないことを示す（Requirement 3.5, 3.6） */
  missing?: boolean;
}

export interface SessionHeaderProps {
  roleChips: RoleChip[];
}

const SCOPE_LABELS: Record<string, string> = {
  readonly: "読み取り専用",
  readwrite: "読み書き",
  admin: "管理者",
};

const SCOPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  readonly: { bg: "#ecfdf5", text: "#065f46", border: "#a7f3d0" },
  readwrite: { bg: "#eff6ff", text: "#1e40af", border: "#93c5fd" },
  admin: { bg: "#fef3c7", text: "#92400e", border: "#fcd34d" },
};

function RoleChipView({ chip }: { chip: RoleChip }) {
  if (chip.missing) {
    return (
      <span
        role="alert"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontWeight: 600,
          fontSize: "0.85rem",
          color: "#b45309",
          whiteSpace: "nowrap",
        }}
      >
        {chip.name}: 元のロールが見つかりません
      </span>
    );
  }

  const scopeLabel = SCOPE_LABELS[chip.scope] ?? chip.scope;
  const scopeColor = SCOPE_COLORS[chip.scope] ?? SCOPE_COLORS.readonly;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
      <span
        style={{
          fontWeight: 600,
          fontSize: "0.9rem",
          color: "var(--color-text, #1a1a2e)",
          whiteSpace: "nowrap",
        }}
      >
        {chip.displayName}（{chip.accountLabel}）
      </span>
      <span
        aria-label={`操作スコープ: ${scopeLabel}`}
        style={{
          display: "inline-block",
          fontSize: "0.7rem",
          fontWeight: 500,
          padding: "0.125rem 0.5rem",
          borderRadius: "9999px",
          backgroundColor: scopeColor.bg,
          color: scopeColor.text,
          border: `1px solid ${scopeColor.border}`,
          whiteSpace: "nowrap",
        }}
      >
        {scopeLabel}
      </span>
    </span>
  );
}

export function SessionHeader({ roleChips }: SessionHeaderProps) {
  return (
    <header
      role="banner"
      aria-label="セッション情報"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        padding: "0.625rem 1rem",
        backgroundColor: "var(--color-surface, #ffffff)",
        borderBottom: "1px solid var(--color-border, #e5e7eb)",
        gap: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      {/* Role_Set の各 Role_Entry をチップとして表示する。missing なチップは個別に
          欠落インジケーターとして表示する（Requirement 3.5, 3.6） */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        {roleChips.map((chip) => (
          <RoleChipView key={chip.name} chip={chip} />
        ))}
      </div>
    </header>
  );
}

export default SessionHeader;
