/**
 * Property-based tests for canAccessChat (accessGates)
 *
 * **Validates: Requirements 4.1, 8.1, 8.5**
 *
 * Property 10: チャットアクセスゲート
 * - 認証済み ∧ カタログ ≥1 件 ∧ 接続選択済み の 3 条件すべて成立時のみ canAccessChat === true
 * - いずれか 1 条件でも不成立ならば canAccessChat === false
 *
 * Tag: Feature: aws-mcp-gateway-agent, Property 10: チャットアクセスゲート
 */

import fc from "fast-check";
import {
  canAccessChat,
  ChatAccessState,
  canAccessFeedbackDashboard,
  canAccessRoleConfigSettings,
} from "./accessGates";

// --- Generators ---

/** 非空の selectedConnectionId */
const nonEmptyConnectionId = fc.string({ minLength: 1, maxLength: 100 });

/** selectedConnectionId: oneof(null, "", non-empty string) */
const anyConnectionId = fc.oneof(
  fc.constant(null),
  fc.constant(""),
  nonEmptyConnectionId
);

/** 有効な selectedConnectionId（非 null かつ非空） */
const validConnectionId = nonEmptyConnectionId;

/** 無効な selectedConnectionId（null または空文字列） */
const invalidConnectionId = fc.oneof(fc.constant(null), fc.constant(""));

/** カタログ件数（0〜100） */
const catalogCount = fc.integer({ min: 0, max: 100 });

/** 全 3 条件が成立する状態 */
const allConditionsMet: fc.Arbitrary<ChatAccessState> = fc.record({
  isAuthenticated: fc.constant(true),
  catalogCount: fc.integer({ min: 1, max: 100 }),
  selectedConnectionId: validConnectionId,
});

/** 少なくとも 1 条件が不成立の状態（3 ビットマスクで制御、mask=0 は除外） */
const someConditionFailed: fc.Arbitrary<ChatAccessState> = fc
  .record({
    mask: fc.integer({ min: 1, max: 7 }),
    validConnectionId: validConnectionId,
    invalidConnectionId: invalidConnectionId,
    validCatalogCount: fc.integer({ min: 1, max: 100 }),
  })
  .map(({ mask, validConnectionId: validId, invalidConnectionId: invalidId, validCatalogCount }) => ({
    // bit 0: isAuthenticated を無効化
    isAuthenticated: !(mask & 1),
    // bit 1: catalogCount を無効化（0）
    catalogCount: mask & 2 ? 0 : validCatalogCount,
    // bit 2: selectedConnectionId を無効化
    selectedConnectionId: mask & 4 ? invalidId : validId,
  }));

// --- Properties ---

describe("Property 10: チャットアクセスゲート", () => {
  it("3 条件すべて成立時に canAccessChat === true", () => {
    fc.assert(
      fc.property(allConditionsMet, (state) => {
        expect(canAccessChat(state)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("いずれか 1 条件が不成立の場合 canAccessChat === false", () => {
    fc.assert(
      fc.property(someConditionFailed, (state) => {
        expect(canAccessChat(state)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("未認証の場合は常に false", () => {
    fc.assert(
      fc.property(catalogCount, anyConnectionId, (count, connId) => {
        const state: ChatAccessState = {
          isAuthenticated: false,
          catalogCount: count,
          selectedConnectionId: connId,
        };
        expect(canAccessChat(state)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("catalogCount === 0 の場合は常に false", () => {
    fc.assert(
      fc.property(fc.boolean(), anyConnectionId, (isAuth, connId) => {
        const state: ChatAccessState = {
          isAuthenticated: isAuth,
          catalogCount: 0,
          selectedConnectionId: connId,
        };
        expect(canAccessChat(state)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("接続未選択（null または空文字列）の場合は常に false", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        catalogCount,
        invalidConnectionId,
        (isAuth, count, connId) => {
          const state: ChatAccessState = {
            isAuthenticated: isAuth,
            catalogCount: count,
            selectedConnectionId: connId,
          };
          expect(canAccessChat(state)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property-based tests for canAccessFeedbackDashboard / canAccessRoleConfigSettings
 *
 * **Validates: Requirements 5.1, 8.6**
 *
 * Property 8: アクセスゲート（Dashboard は全認証・RoleConfig は ADMINS）
 * - 任意の isAuthenticated について canAccessFeedbackDashboard(isAuthenticated) === isAuthenticated
 *   （ADMINS 所属を要求しない = グループに依存しない）
 * - 任意の groups について canAccessRoleConfigSettings(groups) は groups に "ADMINS" を含むことと同値
 *   （既存 ADMINS ゲート維持）
 *
 * Tag: Feature: ui-ux-enhancements, Property 8: アクセスゲート（Dashboard は全認証・RoleConfig は ADMINS）
 */
describe("Property 8: アクセスゲート（Dashboard は全認証・RoleConfig は ADMINS）", () => {
  // --- Generators (local to this describe) ---

  /** 任意の Cognito グループ名 */
  const groupName = fc.oneof(
    fc.constant("ADMINS"),
    fc.constant("USERS"),
    fc.constant("EDITORS"),
    fc.string({ minLength: 1, maxLength: 30 })
  );

  /** 任意のグループ集合 */
  const anyGroups = fc.array(groupName, { maxLength: 8 });

  /** "ADMINS" を含まないグループ集合 */
  const groupsWithoutAdmins = fc
    .array(
      fc.oneof(
        fc.constant("USERS"),
        fc.constant("EDITORS"),
        fc.string({ minLength: 1, maxLength: 30 })
      ),
      { maxLength: 8 }
    )
    .map((groups) => groups.filter((g) => g !== "ADMINS"));

  /** "ADMINS" を必ず含むグループ集合 */
  const groupsWithAdmins = fc
    .array(groupName, { maxLength: 8 })
    .map((groups) => [...groups, "ADMINS"]);

  // --- Properties ---

  it("canAccessFeedbackDashboard(isAuthenticated) === isAuthenticated（任意の認証状態で同値）", () => {
    fc.assert(
      fc.property(fc.boolean(), (isAuthenticated) => {
        expect(canAccessFeedbackDashboard(isAuthenticated)).toBe(
          isAuthenticated
        );
      }),
      { numRuns: 100 }
    );
  });

  it("Dashboard アクセスはグループ集合に依存しない（同一 isAuthenticated なら同一結果）", () => {
    fc.assert(
      fc.property(fc.boolean(), anyGroups, (isAuthenticated) => {
        // groups を受け取らないシグネチャなので、結果は isAuthenticated のみで決まる
        expect(canAccessFeedbackDashboard(isAuthenticated)).toBe(
          isAuthenticated
        );
      }),
      { numRuns: 100 }
    );
  });

  it("canAccessRoleConfigSettings(groups) は groups に \"ADMINS\" を含むことと同値", () => {
    fc.assert(
      fc.property(anyGroups, (groups) => {
        expect(canAccessRoleConfigSettings(groups)).toBe(
          groups.includes("ADMINS")
        );
      }),
      { numRuns: 100 }
    );
  });

  it("ADMINS を含まないグループでは RoleConfig アクセス不可（false）", () => {
    fc.assert(
      fc.property(groupsWithoutAdmins, (groups) => {
        expect(canAccessRoleConfigSettings(groups)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("ADMINS を含むグループでは RoleConfig アクセス可（true）", () => {
    fc.assert(
      fc.property(groupsWithAdmins, (groups) => {
        expect(canAccessRoleConfigSettings(groups)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("Dashboard ゲートと RoleConfig ゲートは独立（RoleConfig は認証状態に依存しない）", () => {
    fc.assert(
      fc.property(fc.boolean(), anyGroups, (isAuthenticated, groups) => {
        // RoleConfig は groups のみで決まり isAuthenticated に依存しない
        expect(canAccessRoleConfigSettings(groups)).toBe(
          groups.includes("ADMINS")
        );
        // Dashboard は isAuthenticated のみで決まる
        expect(canAccessFeedbackDashboard(isAuthenticated)).toBe(
          isAuthenticated
        );
      }),
      { numRuns: 100 }
    );
  });
});
