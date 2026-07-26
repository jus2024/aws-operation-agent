/**
 * Property-based tests for canAccessAdminControls (accessGates)
 *
 * **Validates: Requirements 8.6, 8.7, 9.5**
 *
 * Property 11: 管理者向け UI ゲート
 * - groups 配列に "ADMINS" を含む場合 → canAccessAdminControls === true
 * - groups 配列に "ADMINS" を含まない場合 → canAccessAdminControls === false
 *
 * Tag: Feature: aws-mcp-gateway-agent, Property 11: 管理者向け UI ゲート
 */

import fc from "fast-check";
import { canAccessAdminControls } from "./accessGates";

// --- Strategies ---

/**
 * "ADMINS" 以外のグループ名を生成する。
 * 空文字列や "ADMINS" のサブストリングなどもカバーする。
 */
const nonAdminGroupName = fc
  .string({ minLength: 0, maxLength: 50 })
  .filter((s) => s !== "ADMINS");

/**
 * "ADMINS" を含むグループ配列:
 * ランダムなグループ名の配列に "ADMINS" をランダムな位置に挿入する。
 */
const groupsWithAdmins: fc.Arbitrary<string[]> = fc
  .record({
    otherGroups: fc.array(nonAdminGroupName, { minLength: 0, maxLength: 10 }),
    insertIndex: fc.nat(),
  })
  .map(({ otherGroups, insertIndex }) => {
    const result = [...otherGroups];
    const idx = insertIndex % (result.length + 1);
    result.splice(idx, 0, "ADMINS");
    return result;
  });

/**
 * "ADMINS" を含まないグループ配列:
 * 各要素が "ADMINS" でないことを保証する。
 */
const groupsWithoutAdmins: fc.Arbitrary<string[]> = fc.array(
  nonAdminGroupName,
  { minLength: 0, maxLength: 10 }
);

// --- Properties ---

describe("Property 11: 管理者向け UI ゲート", () => {
  it("groups に ADMINS を含む場合 canAccessAdminControls === true", () => {
    fc.assert(
      fc.property(groupsWithAdmins, (groups) => {
        expect(canAccessAdminControls(groups)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("groups に ADMINS を含まない場合 canAccessAdminControls === false", () => {
    fc.assert(
      fc.property(groupsWithoutAdmins, (groups) => {
        expect(canAccessAdminControls(groups)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
