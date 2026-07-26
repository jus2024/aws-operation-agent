"use client";

import { useCallback, useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import { canAccessRoleConfigSettings } from "@/src/lib/agent/accessGates";
import { RoleConfigForm, type RoleConfigFormValues } from "./RoleConfigForm";

/**
 * RoleConfigManager — Role_Config_Table メンテナンス画面（ADMINS 専用）
 *
 * `groups` に "ADMINS" が含まれない場合は `canAccessRoleConfigSettings(groups)`
 * が false を返すため、CRUD フォームやデータ取得を一切行わず「このページを
 * 表示する権限がありません」のみを描画する（Requirement 8.2）。実際のデータ
 * アクセス制御は Amplify Data Model の `allow.group("ADMINS")` 認可がサーバー
 * サイドで強制するため、このフロントエンド側チェックは UX 目的の二重防御である。
 *
 * true の場合、`generateClient<Schema>()` で `client.models.RoleConfig.list()`
 * / `.create()` / `.update()` を呼び出す。論理削除方針のため `.delete()` は
 * 使用しない。削除操作は確認ダイアログを経由し、確認後に
 * `client.models.RoleConfig.update({ id, isActive: false })` を実行する
 * （Requirement 8.6）。再アクティブ化操作は提供しない（Requirement 8.8）。
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */

type RoleConfigRecord = Schema["RoleConfig"]["type"];

export interface RoleConfigManagerProps {
  groups: string[];
  onClose: () => void;
}

const SCOPE_LABELS: Record<string, string> = {
  readonly: "読み取り専用",
  readwrite: "読み書き",
  admin: "管理者",
};

const EMPTY_FORM_VALUES: RoleConfigFormValues = {
  name: "",
  displayName: "",
  accountLabel: "",
  roleArn: "",
  scope: "",
};

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "update"; record: RoleConfigRecord };

export function RoleConfigManager({ groups, onClose }: RoleConfigManagerProps) {
  const canAccess = canAccessRoleConfigSettings(groups);

  const [records, setRecords] = useState<RoleConfigRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [formState, setFormState] = useState<FormState>({ mode: "closed" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<RoleConfigRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchRecords = useCallback(async () => {
    if (!canAccess) {
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      const client = generateClient<Schema>();
      const { data, errors } = await client.models.RoleConfig.list();

      if (errors && errors.length > 0) {
        setLoadError(errors.map((e) => e.message).join(", "));
        setRecords([]);
      } else {
        setRecords(data ?? []);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Role_Entry 一覧の取得に失敗しました";
      setLoadError(message);
      setRecords([]);
    } finally {
      setIsLoading(false);
    }
  }, [canAccess]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  if (!canAccess) {
    return (
      <div
        role="alert"
        style={{
          padding: "2rem",
          textAlign: "center",
          color: "#b91c1c",
          fontSize: "0.9rem",
        }}
      >
        このページを表示する権限がありません
      </div>
    );
  }

  // 一意性チェックは isActive の値に関わらず全レコードの name を対象とする
  // （Requirement 8.3, 8.4）。更新時は編集対象自身の現在の name を除外する
  // （Requirement 8.5）。
  const allNames = records.map((r) => r.name);
  const existingNames =
    formState.mode === "update"
      ? allNames.filter((name) => name !== formState.record.name)
      : allNames;

  // Account_Label の表記を統一したい運用上の要望に対応するため、既存レコード
  // （isActive の値に関わらない）の accountLabel から重複を除いた一覧を
  // datalist の候補として渡す。
  const existingAccountLabels = Array.from(
    new Set(records.map((r) => r.accountLabel).filter((label) => label.trim().length > 0)),
  ).sort();

  const visibleRecords = showInactive
    ? records
    : records.filter((r) => r.isActive !== false);

  function openCreateForm() {
    setSubmitError(null);
    setFormState({ mode: "create" });
  }

  function openUpdateForm(record: RoleConfigRecord) {
    setSubmitError(null);
    setFormState({ mode: "update", record });
  }

  function closeForm() {
    setSubmitError(null);
    setFormState({ mode: "closed" });
  }

  async function handleFormSubmit(values: RoleConfigFormValues) {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const client = generateClient<Schema>();

      if (formState.mode === "create") {
        const { data, errors } = await client.models.RoleConfig.create({
          name: values.name,
          displayName: values.displayName,
          accountLabel: values.accountLabel,
          roleArn: values.roleArn,
          scope: values.scope as RoleConfigRecord["scope"],
          isActive: true,
        });

        if (errors && errors.length > 0) {
          setSubmitError(errors.map((e) => e.message).join(", "));
          return;
        }

        if (data) {
          setRecords((prev) => [...prev, data]);
        }
        setFormState({ mode: "closed" });
      } else if (formState.mode === "update") {
        const { data, errors } = await client.models.RoleConfig.update({
          id: formState.record.id,
          name: values.name,
          displayName: values.displayName,
          accountLabel: values.accountLabel,
          roleArn: values.roleArn,
          scope: values.scope as RoleConfigRecord["scope"],
        });

        if (errors && errors.length > 0) {
          setSubmitError(errors.map((e) => e.message).join(", "));
          return;
        }

        if (data) {
          setRecords((prev) => prev.map((r) => (r.id === data.id ? data : r)));
        }
        setFormState({ mode: "closed" });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "保存中にエラーが発生しました";
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function requestDelete(record: RoleConfigRecord) {
    setDeleteError(null);
    setDeleteTarget(record);
  }

  function cancelDelete() {
    setDeleteError(null);
    setDeleteTarget(null);
  }

  async function confirmDelete() {
    if (!deleteTarget) {
      return;
    }

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const client = generateClient<Schema>();
      // 論理削除: isActive を false に更新するのみ。.delete() は使用しない
      // （Requirement 8.6）。
      const { data, errors } = await client.models.RoleConfig.update({
        id: deleteTarget.id,
        isActive: false,
      });

      if (errors && errors.length > 0) {
        setDeleteError(errors.map((e) => e.message).join(", "));
        return;
      }

      if (data) {
        setRecords((prev) => prev.map((r) => (r.id === data.id ? data : r)));
      }
      setDeleteTarget(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "無効化中にエラーが発生しました";
      setDeleteError(message);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Role_Config メンテナンス画面"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        padding: "1.25rem",
        maxWidth: "48rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h2
          style={{
            fontSize: "1.05rem",
            fontWeight: 600,
            margin: 0,
            color: "var(--color-text, #1a1a2e)",
          }}
        >
          ロール設定管理
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          style={{
            fontSize: "0.8rem",
            fontWeight: 500,
            padding: "0.375rem 0.75rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--color-border, #d1d5db)",
            backgroundColor: "var(--color-surface, #ffffff)",
            color: "var(--color-text-secondary, #374151)",
            cursor: "pointer",
          }}
        >
          閉じる
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.8rem",
            color: "var(--color-text-secondary, #374151)",
          }}
        >
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          非アクティブなエントリを表示
        </label>

        {formState.mode === "closed" && (
          <button
            type="button"
            onClick={openCreateForm}
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              padding: "0.5rem 0.875rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--color-primary, #0073bb)",
              backgroundColor: "var(--color-primary, #0073bb)",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            + 新規 Role_Entry
          </button>
        )}
      </div>

      {formState.mode !== "closed" && (
        <RoleConfigForm
          mode={formState.mode}
          initialValues={
            formState.mode === "update"
              ? {
                  name: formState.record.name,
                  displayName: formState.record.displayName,
                  accountLabel: formState.record.accountLabel,
                  roleArn: formState.record.roleArn,
                  scope: formState.record.scope ?? "",
                }
              : EMPTY_FORM_VALUES
          }
          existingNames={existingNames}
          existingAccountLabels={existingAccountLabels}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onSubmit={handleFormSubmit}
          onCancel={closeForm}
        />
      )}

      {isLoading && (
        <div role="status" style={{ fontSize: "0.85rem", color: "var(--color-text-secondary, #6b7280)" }}>
          読み込み中...
        </div>
      )}

      {loadError && (
        <div role="alert" style={{ fontSize: "0.85rem", color: "#b91c1c" }}>
          {loadError}
        </div>
      )}

      {!isLoading && !loadError && visibleRecords.length === 0 && (
        <div style={{ fontSize: "0.85rem", color: "var(--color-text-secondary, #6b7280)" }}>
          Role_Entry がまだ登録されていません
        </div>
      )}

      {!isLoading && !loadError && visibleRecords.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {visibleRecords.map((record) => {
            const isInactive = record.isActive === false;
            const scopeLabel = SCOPE_LABELS[record.scope ?? ""] ?? record.scope;

            return (
              <li
                key={record.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.75rem",
                  padding: "0.75rem 1rem",
                  border: "1px solid var(--color-border, #e5e7eb)",
                  borderRadius: "0.5rem",
                  backgroundColor: isInactive
                    ? "var(--color-surface-muted, #f3f4f6)"
                    : "var(--color-surface, #ffffff)",
                  color: isInactive
                    ? "var(--color-text-secondary, #9ca3af)"
                    : "var(--color-text, #1a1a2e)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                      {record.displayName}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "var(--color-text-secondary, #6b7280)" }}>
                      ({record.name})
                    </span>
                    {isInactive && (
                      <span
                        aria-label="非アクティブ"
                        style={{
                          display: "inline-block",
                          fontSize: "0.7rem",
                          fontWeight: 500,
                          padding: "0.125rem 0.5rem",
                          borderRadius: "9999px",
                          backgroundColor: "#e5e7eb",
                          color: "#4b5563",
                          border: "1px solid #d1d5db",
                        }}
                      >
                        非アクティブ
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary, #6b7280)" }}>
                    Account_Label: {record.accountLabel} / Scope: {scopeLabel}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--color-text-secondary, #9ca3af)", wordBreak: "break-all" }}>
                    {record.roleArn}
                  </div>
                </div>

                {!isInactive && (
                  <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => openUpdateForm(record)}
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        padding: "0.375rem 0.75rem",
                        borderRadius: "0.375rem",
                        border: "1px solid var(--color-border, #d1d5db)",
                        backgroundColor: "var(--color-surface, #ffffff)",
                        color: "var(--color-text-secondary, #374151)",
                        cursor: "pointer",
                      }}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => requestDelete(record)}
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        padding: "0.375rem 0.75rem",
                        borderRadius: "0.375rem",
                        border: "1px solid #fca5a5",
                        backgroundColor: "#fef2f2",
                        color: "#b91c1c",
                        cursor: "pointer",
                      }}
                    >
                      削除
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {deleteTarget && (
        <div
          role="alertdialog"
          aria-label="削除確認"
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            zIndex: 50,
          }}
        >
          <div
            style={{
              backgroundColor: "var(--color-surface, #ffffff)",
              borderRadius: "0.5rem",
              padding: "1.5rem",
              maxWidth: "24rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--color-text, #1a1a2e)" }}>
              このロールを無効化します。無効化すると Role_Name「{deleteTarget.name}」は今後再利用できません。よろしいですか？
            </p>
            {deleteError && (
              <div role="alert" style={{ fontSize: "0.8rem", color: "#b91c1c" }}>
                {deleteError}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={cancelDelete}
                disabled={isDeleting}
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 500,
                  padding: "0.5rem 0.875rem",
                  borderRadius: "0.375rem",
                  border: "1px solid var(--color-border, #d1d5db)",
                  backgroundColor: "var(--color-surface, #ffffff)",
                  color: "var(--color-text-secondary, #374151)",
                  cursor: isDeleting ? "not-allowed" : "pointer",
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={isDeleting}
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  padding: "0.5rem 0.875rem",
                  borderRadius: "0.375rem",
                  border: "1px solid #dc2626",
                  backgroundColor: "#dc2626",
                  color: "#ffffff",
                  cursor: isDeleting ? "not-allowed" : "pointer",
                  opacity: isDeleting ? 0.7 : 1,
                }}
              >
                {isDeleting ? "処理中..." : "無効化する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RoleConfigManager;
