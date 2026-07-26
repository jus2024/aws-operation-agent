/**
 * Role_Config メンテナンス画面（RoleConfigManager / RoleConfigForm）の
 * バリデーション・論理削除ロジック（純粋関数モジュール）
 *
 * `roleSetSelection.ts` / `copilotProperties.ts` / `accessGates.ts` と同じ
 * 「UI ロジックを純粋関数に切り出す」パターンを踏襲する。
 * React hooks や API コール（Amplify Data クライアント）に依存しない。
 *
 * Requirements: 8.3, 8.4, 8.5, 8.6, 8.8
 */

export interface RoleConfigInput {
  name: string;
  displayName: string;
  accountLabel: string;
  roleArn: string;
  scope: string;
}

export interface RoleConfigValidationErrors {
  name?: string;
  displayName?: string;
  accountLabel?: string;
  roleArn?: string;
  scope?: string;
}

export const VALID_SCOPES = new Set(["readonly", "readwrite", "admin"]);

/**
 * Role_Name に許可する文字パターン。半角英数字・ハイフン・アンダースコアのみ
 * （日本語や空白を含む表示名と区別するための制約。既存データの
 * "readonly-a" のようなハイフン区切りの命名を許容する）。
 */
export const ROLE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Role_Entry 作成・更新フォームの入力を検証する。
 *
 * 一意性チェックは Role_Config_Table 内の全 Role_Name の一覧
 * （isActive の値に関わらない、アクティブ・非アクティブ双方のレコードの
 * name。更新時は自分自身の元の name を除外したもの）を `existingNames`
 * として引数で受け取る。この関数自体は純粋関数のまま保つ
 * （呼び出し側が Amplify Data クライアントで一覧を取得し、フィルタなしで
 * 渡す責務を負う）。
 *
 * existingNames に非アクティブなレコードの name を含めることで、
 * 一度非アクティブ化された Role_Name の再利用を拒否する
 * （Requirement 8.8）。
 *
 * Role_Name は半角英数字・ハイフン・アンダースコアのみを許可する
 * （`ROLE_NAME_PATTERN`）。日本語を含められる表示名（displayName）とは
 * 異なり、Chat_Session への保存キー・Agent 側の検索キーとして使われる
 * 安定した識別子であるため。更新モードでは name フィールド自体を
 * `RoleConfigForm` 側で編集不可（disabled）にする運用とする
 * （name はここでは形式チェックのみ行い、更新時に値が変わっていないかの
 * 検証は行わない）。
 *
 * Requirements: 8.3, 8.4, 8.5, 8.8
 */
export function validateRoleConfigInput(
  input: RoleConfigInput,
  existingNames: string[],
): RoleConfigValidationErrors {
  const errors: RoleConfigValidationErrors = {};

  if (!input.name.trim()) {
    errors.name = "Role_Name は必須です";
  } else if (!ROLE_NAME_PATTERN.test(input.name)) {
    errors.name = "Role_Name は半角英数字・ハイフン・アンダースコアのみ使用できます";
  } else if (existingNames.includes(input.name)) {
    errors.name = "この Role_Name は既に使用されています";
  }

  if (!input.displayName.trim()) errors.displayName = "表示名は必須です";
  if (!input.accountLabel.trim()) errors.accountLabel = "Account_Label は必須です";
  if (!input.roleArn.trim()) errors.roleArn = "Role_ARN は必須です";
  if (!VALID_SCOPES.has(input.scope)) errors.scope = "Operation_Scope が不正です";

  return errors;
}

/**
 * バリデーションエラーが1件もない場合のみ送信可能。
 *
 * Requirements: 8.3, 8.5
 */
export function canSubmitRoleConfig(errors: RoleConfigValidationErrors): boolean {
  return Object.keys(errors).length === 0;
}

export interface RoleConfigRecord {
  name: string;
  isActive: boolean;
}

/**
 * Role_Entry の論理削除を適用した新しい配列を返す。
 *
 * `targetName` に一致するレコードの `isActive` のみを `false` に変更し、
 * 他のレコードと、全レコードのレコード件数・（呼び出し側が保持する）識別
 * 情報は変更しない。一致するレコードがない場合は変更なしで元の配列と
 * 等価な内容の新しい配列を返す。
 *
 * 入力の `records` 自体は変更しない（新しい配列・新しいオブジェクトを返す）。
 *
 * Requirements: 8.6
 */
export function applyLogicalDelete<T extends RoleConfigRecord>(
  records: T[],
  targetName: string,
): T[] {
  return records.map((record) =>
    record.name === targetName ? { ...record, isActive: false } : record,
  );
}
