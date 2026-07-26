import { describe, expect, it } from "vitest";
import { validateRoleConfigInput, type RoleConfigInput } from "./roleConfigValidation";

function buildInput(overrides: Partial<RoleConfigInput> = {}): RoleConfigInput {
  return {
    name: "readonly-a",
    displayName: "読み取り専用A",
    accountLabel: "メイン環境",
    roleArn: "arn:aws:iam::123456789012:role/AgentMCPReadOnlyRole",
    scope: "readonly",
    ...overrides,
  };
}

describe("validateRoleConfigInput - Role_Name format", () => {
  it("英数字・ハイフン・アンダースコアのみの name はエラーなし", () => {
    const errors = validateRoleConfigInput(buildInput({ name: "Admin_Role-1" }), []);
    expect(errors.name).toBeUndefined();
  });

  it("日本語を含む name はエラーになる", () => {
    const errors = validateRoleConfigInput(buildInput({ name: "読み取り専用" }), []);
    expect(errors.name).toBe("Role_Name は半角英数字・ハイフン・アンダースコアのみ使用できます");
  });

  it("スペースを含む name はエラーになる", () => {
    const errors = validateRoleConfigInput(buildInput({ name: "read only" }), []);
    expect(errors.name).toBe("Role_Name は半角英数字・ハイフン・アンダースコアのみ使用できます");
  });

  it("空文字の name は必須エラーになる（フォーマットエラーではない）", () => {
    const errors = validateRoleConfigInput(buildInput({ name: "" }), []);
    expect(errors.name).toBe("Role_Name は必須です");
  });

  it("フォーマットが正しくても既存 name と重複していれば重複エラーになる", () => {
    const errors = validateRoleConfigInput(buildInput({ name: "admin" }), ["admin"]);
    expect(errors.name).toBe("この Role_Name は既に使用されています");
  });
});
