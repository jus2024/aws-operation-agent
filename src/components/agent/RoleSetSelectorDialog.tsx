"use client";

import { useEffect, useRef, useState } from "react";
import type { RoleInfo } from "@/src/lib/agent/roleInfo";
import { canConfirmRoleSet, toggleRoleSelection } from "@/src/lib/agent/roleSetSelection";
import { MAX_SESSION_NAME_LENGTH } from "@/src/lib/agent/sessionNameResolver";

/**
 * RoleSetSelectorDialog — 新規チャット開始時の Role_Set 選択モーダルダイアログ
 *
 * `RoleSelector.tsx` の後継。全画面ではなくモーダルダイアログとして、サイドバーの
 * 「+ 新規チャット」ボタンから開く。各 `RoleInfo` をチェックボックス付きの行
 * （displayName + Account_Label バッジ + Operation_Scope バッジ）で表示し、
 * admin/readonly が混在してもフィルタしない（Requirement 2.3）。
 *
 * 選択状態はダイアログ内のローカル state（`Set<string>`）で管理し、
 * `toggleRoleSelection` / `canConfirmRoleSet`（roleSetSelection.ts）で
 * 「開始」ボタンの有効/無効を判定する。0件選択時はボタンを非活性にし、
 * バリデーションメッセージを表示する（Requirement 2.5）。
 *
 * `roles` が空（かつ読み込み中でない）場合はダイアログを開かない。呼び出し元
 * （`SessionHistorySidebar` の「+ 新規チャット」ボタン）がエラーメッセージの
 * 表示を担当する（design.md Component 1 参照、Requirement 2.7）。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 2.7
 */

export interface RoleSetSelectorDialogProps {
  isOpen: boolean;
  roles: RoleInfo[];
  isLoading: boolean;
  onConfirm: (roleNames: string[], sessionName?: string) => void;
  onCancel: () => void;
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

const ACCOUNT_LABEL_BADGE_COLOR = { bg: "#f3f4f6", text: "#374151", border: "#d1d5db" };

export function RoleSetSelectorDialog({
  isOpen,
  roles,
  isLoading,
  onConfirm,
  onCancel,
}: RoleSetSelectorDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sessionName, setSessionName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // ダイアログが開くたびに選択状態・チャット名入力欄をリセットする。
  useEffect(() => {
    if (isOpen) {
      setSelected(new Set());
      setSessionName("");
    }
  }, [isOpen]);

  // Escape キーでキャンセルする（アクセシビリティ: モーダルダイアログの標準操作）。
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  // ダイアログが開いたらフォーカスをダイアログ本体に移す。
  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  // roles が空かつ読み込み中でない場合はダイアログを開かない
  // （呼び出し元がエラー表示を担当する。Requirement 2.7）。
  if (!isLoading && roles.length === 0) {
    return null;
  }

  const selectedRoleNames = Array.from(selected);
  const canConfirm = canConfirmRoleSet(selectedRoleNames);

  const handleToggle = (roleName: string) => {
    setSelected((prev) => toggleRoleSelection(prev, roleName));
  };

  const handleConfirm = () => {
    if (!canConfirm) return;
    // 空欄（前後の空白のみを含む）の場合は sessionName を渡さない。呼び出し先
    // （buildChatSessionCreateInput）が未指定時に defaultSessionName() へ
    // フォールバックする既存の挙動をそのまま使う。
    const trimmedName = sessionName.trim();
    onConfirm(selectedRoleNames, trimmedName.length > 0 ? trimmedName : undefined);
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.4)",
        padding: "1rem",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-set-selector-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          width: "100%",
          maxWidth: "28rem",
          maxHeight: "80vh",
          padding: "1.5rem",
          borderRadius: "var(--radius, 0.5rem)",
          backgroundColor: "var(--color-surface, #ffffff)",
          boxShadow: "0 10px 25px rgba(0, 0, 0, 0.15)",
          overflow: "hidden",
        }}
      >
        <h2
          id="role-set-selector-dialog-title"
          style={{
            fontSize: "1rem",
            fontWeight: 600,
            color: "var(--color-text, #1a1a2e)",
            margin: 0,
          }}
        >
          利用するロールを選択してください
        </h2>

        {/* 任意のチャット名入力欄。空欄の場合は最初のメッセージから自動生成される
            既存の挙動（defaultSessionName → generateSessionName）を維持する。 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <label
            htmlFor="role-set-selector-session-name"
            style={{
              fontSize: "0.8rem",
              fontWeight: 500,
              color: "var(--color-text-secondary, #374151)",
            }}
          >
            チャット名（任意）
          </label>
          <input
            id="role-set-selector-session-name"
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="未入力の場合は自動で設定されます"
            maxLength={MAX_SESSION_NAME_LENGTH}
            style={{
              fontSize: "0.9rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--color-border, #d1d5db)",
              backgroundColor: "var(--color-surface, #ffffff)",
              color: "var(--color-text, #1a1a2e)",
            }}
          />
        </div>

        {isLoading ? (
          <div
            role="status"
            aria-label="ロール読み込み中"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "2rem",
              color: "var(--color-text-secondary, #6b7280)",
              fontSize: "0.9rem",
            }}
          >
            読み込み中...
          </div>
        ) : (
          <ul
            role="listbox"
            aria-multiselectable="true"
            aria-label="利用可能なロール一覧"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              overflowY: "auto",
            }}
          >
            {roles.map((role) => {
              const scopeLabel = SCOPE_LABELS[role.scope] ?? role.scope;
              const scopeColor = SCOPE_COLORS[role.scope] ?? SCOPE_COLORS.readonly;
              const isChecked = selected.has(role.name);
              const checkboxId = `role-set-selector-checkbox-${role.name}`;

              return (
                <li key={role.name} role="option" aria-selected={isChecked}>
                  <label
                    htmlFor={checkboxId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.75rem 1rem",
                      border: `1px solid ${
                        isChecked ? "var(--color-primary, #0073bb)" : "var(--color-border, #e5e7eb)"
                      }`,
                      borderRadius: "var(--radius, 0.5rem)",
                      backgroundColor: isChecked
                        ? "var(--color-primary-subtle, #eff6ff)"
                        : "var(--color-surface, #ffffff)",
                      cursor: "pointer",
                      transition: "border-color 0.15s, background-color 0.15s",
                    }}
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleToggle(role.name)}
                      style={{ flexShrink: 0, width: "1rem", height: "1rem", cursor: "pointer" }}
                    />
                    <span
                      style={{
                        flex: 1,
                        fontSize: "0.9rem",
                        fontWeight: 500,
                        color: "var(--color-text, #1a1a2e)",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {role.displayName}
                    </span>
                    <span
                      aria-label={`アカウント: ${role.accountLabel}`}
                      style={{
                        display: "inline-block",
                        fontSize: "0.7rem",
                        fontWeight: 500,
                        padding: "0.125rem 0.5rem",
                        borderRadius: "9999px",
                        backgroundColor: ACCOUNT_LABEL_BADGE_COLOR.bg,
                        color: ACCOUNT_LABEL_BADGE_COLOR.text,
                        border: `1px solid ${ACCOUNT_LABEL_BADGE_COLOR.border}`,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {role.accountLabel}
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
                        flexShrink: 0,
                      }}
                    >
                      {scopeLabel}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {/* 0件選択時のバリデーションメッセージ（Requirement 2.5） */}
        {!isLoading && !canConfirm && (
          <p
            role="alert"
            style={{
              margin: 0,
              fontSize: "0.8rem",
              color: "#b45309",
            }}
          >
            少なくとも1つのロールを選択してください
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: "0.85rem",
              fontWeight: 500,
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--color-border, #d1d5db)",
              backgroundColor: "var(--color-surface, #ffffff)",
              color: "var(--color-text-secondary, #374151)",
              cursor: "pointer",
            }}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm || isLoading}
            aria-disabled={!canConfirm || isLoading}
            style={{
              fontSize: "0.85rem",
              fontWeight: 500,
              padding: "0.5rem 1rem",
              borderRadius: "0.375rem",
              border: "none",
              backgroundColor:
                canConfirm && !isLoading
                  ? "var(--color-primary, #0073bb)"
                  : "var(--color-border, #d1d5db)",
              color: canConfirm && !isLoading ? "#ffffff" : "var(--color-text-secondary, #6b7280)",
              cursor: canConfirm && !isLoading ? "pointer" : "not-allowed",
            }}
          >
            開始
          </button>
        </div>
      </div>
    </div>
  );
}

export default RoleSetSelectorDialog;
