"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import {
  validateRoleConfigInput,
  canSubmitRoleConfig,
  VALID_SCOPES,
  type RoleConfigInput,
  type RoleConfigValidationErrors,
} from "@/src/lib/agent/roleConfigValidation";

/**
 * RoleConfigForm — Role_Entry 作成・更新共通フォーム
 *
 * `RoleConfigManager` から呼び出される、Role_Name・表示名・Account_Label・
 * Role_ARN・Operation_Scope の入力フォーム。送信前に `roleConfigValidation.ts`
 * の `validateRoleConfigInput` でクライアントサイド検証を行い、フィールド単位の
 * インラインエラーを表示する。実際の一意性チェック用の `existingNames`
 * （更新時は編集対象自身の現在の name を除外したもの）は呼び出し元
 * （`RoleConfigManager`）が構築して渡す。
 *
 * Requirements: 8.3, 8.4, 8.5
 */

export type RoleConfigFormValues = RoleConfigInput;

export interface RoleConfigFormProps {
  mode: "create" | "update";
  initialValues: RoleConfigFormValues;
  /**
   * Role_Config_Table 内の全レコード（isActive の値に関わらない）の name。
   * 更新時は呼び出し元が編集対象自身の現在の name を除外して渡す
   * （Requirement 8.5）。
   */
  existingNames: string[];
  /**
   * Role_Config_Table 内の全レコード（isActive の値に関わらない）の
   * accountLabel から重複を除いた一覧。Account_Label 入力に `datalist` として
   * 渡し、既存の値からの選択と新規入力の両方を許可する
   * （Account_Label の表記を極力統一したい運用上の要望に対応）。
   */
  existingAccountLabels: string[];
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (values: RoleConfigFormValues) => void;
  onCancel: () => void;
}

const SCOPE_OPTIONS = Array.from(VALID_SCOPES);

const SCOPE_LABELS: Record<string, string> = {
  readonly: "読み取り専用",
  readwrite: "読み書き",
  admin: "管理者",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.8rem",
  fontWeight: 500,
  color: "var(--color-text, #1a1a2e)",
};

const inputStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--color-border, #d1d5db)",
  fontSize: "0.85rem",
};

const errorTextStyle: CSSProperties = {
  color: "#b91c1c",
  fontSize: "0.75rem",
};

export function RoleConfigForm({
  mode,
  initialValues,
  existingNames,
  existingAccountLabels,
  isSubmitting,
  submitError,
  onSubmit,
  onCancel,
}: RoleConfigFormProps) {
  const [values, setValues] = useState<RoleConfigFormValues>(initialValues);
  const [errors, setErrors] = useState<RoleConfigValidationErrors>({});

  function updateField<K extends keyof RoleConfigFormValues>(
    field: K,
    value: RoleConfigFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationErrors = validateRoleConfigInput(values, existingNames);
    setErrors(validationErrors);

    if (!canSubmitRoleConfig(validationErrors)) {
      return;
    }

    onSubmit(values);
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={mode === "create" ? "Role_Entry の新規作成フォーム" : "Role_Entry の更新フォーム"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        padding: "1rem",
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.5rem",
        backgroundColor: "var(--color-surface, #ffffff)",
      }}
    >
      <label style={labelStyle}>
        Role_Name
        <input
          type="text"
          value={values.name}
          onChange={(e) => updateField("name", e.target.value)}
          // Role_Name は Chat_Session への保存キー・Agent 側の検索キーとして
          // 使われる安定した識別子のため、作成後は変更不可にする
          disabled={mode === "update"}
          style={inputStyle}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={
            errors.name
              ? "role-config-form-name-error"
              : "role-config-form-name-hint"
          }
        />
        {mode === "create" && !errors.name && (
          <span id="role-config-form-name-hint" style={{ fontSize: "0.75rem", color: "var(--color-text-secondary, #6b7280)" }}>
            半角英数字・ハイフン・アンダースコアのみ。作成後は変更できません
          </span>
        )}
        {errors.name && (
          <span id="role-config-form-name-error" role="alert" style={errorTextStyle}>
            {errors.name}
          </span>
        )}
      </label>

      <label style={labelStyle}>
        表示名
        <input
          type="text"
          value={values.displayName}
          onChange={(e) => updateField("displayName", e.target.value)}
          style={inputStyle}
          aria-invalid={errors.displayName ? true : undefined}
          aria-describedby={
            errors.displayName ? "role-config-form-displayname-error" : undefined
          }
        />
        {errors.displayName && (
          <span id="role-config-form-displayname-error" role="alert" style={errorTextStyle}>
            {errors.displayName}
          </span>
        )}
      </label>

      <label style={labelStyle}>
        Account_Label
        <input
          type="text"
          value={values.accountLabel}
          onChange={(e) => updateField("accountLabel", e.target.value)}
          list="role-config-form-accountlabel-options"
          style={inputStyle}
          aria-invalid={errors.accountLabel ? true : undefined}
          aria-describedby={
            errors.accountLabel ? "role-config-form-accountlabel-error" : undefined
          }
        />
        {/* 既存の Account_Label から選択、または新規入力できるようにする
            （表記を統一したい運用上の要望への対応）。datalist はブラウザ
            標準の候補リストのため、選択肢に無い値の入力も妨げない。 */}
        <datalist id="role-config-form-accountlabel-options">
          {existingAccountLabels.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
        {errors.accountLabel && (
          <span id="role-config-form-accountlabel-error" role="alert" style={errorTextStyle}>
            {errors.accountLabel}
          </span>
        )}
      </label>

      <label style={labelStyle}>
        Role_ARN
        <input
          type="text"
          value={values.roleArn}
          onChange={(e) => updateField("roleArn", e.target.value)}
          style={inputStyle}
          aria-invalid={errors.roleArn ? true : undefined}
          aria-describedby={errors.roleArn ? "role-config-form-rolearn-error" : undefined}
        />
        {errors.roleArn && (
          <span id="role-config-form-rolearn-error" role="alert" style={errorTextStyle}>
            {errors.roleArn}
          </span>
        )}
      </label>

      <label style={labelStyle}>
        Operation_Scope
        <select
          value={values.scope}
          onChange={(e) => updateField("scope", e.target.value)}
          style={inputStyle}
          aria-invalid={errors.scope ? true : undefined}
          aria-describedby={errors.scope ? "role-config-form-scope-error" : undefined}
        >
          <option value="" disabled>
            選択してください
          </option>
          {SCOPE_OPTIONS.map((scope) => (
            <option key={scope} value={scope}>
              {SCOPE_LABELS[scope] ?? scope}
            </option>
          ))}
        </select>
        {errors.scope && (
          <span id="role-config-form-scope-error" role="alert" style={errorTextStyle}>
            {errors.scope}
          </span>
        )}
      </label>

      {submitError && (
        <div role="alert" style={{ ...errorTextStyle, fontWeight: 500 }}>
          {submitError}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          style={{
            fontSize: "0.8rem",
            fontWeight: 500,
            padding: "0.5rem 0.875rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--color-border, #d1d5db)",
            backgroundColor: "var(--color-surface, #ffffff)",
            color: "var(--color-text-secondary, #374151)",
            cursor: isSubmitting ? "not-allowed" : "pointer",
          }}
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          style={{
            fontSize: "0.8rem",
            fontWeight: 600,
            padding: "0.5rem 0.875rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--color-primary, #0073bb)",
            backgroundColor: "var(--color-primary, #0073bb)",
            color: "#ffffff",
            cursor: isSubmitting ? "not-allowed" : "pointer",
            opacity: isSubmitting ? 0.7 : 1,
          }}
        >
          {isSubmitting ? "送信中..." : mode === "create" ? "作成する" : "更新する"}
        </button>
      </div>
    </form>
  );
}

export default RoleConfigForm;
