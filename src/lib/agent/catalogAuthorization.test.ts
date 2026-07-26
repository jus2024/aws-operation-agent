/**
 * Property-based test for catalog authorization decisions
 *
 * Feature: aws-mcp-gateway-agent, Property 6: カタログ認可の決定
 * Validates: Requirements 3.4, 6.3, 9.3, 9.4
 *
 * 任意の（ユーザーのグループ集合, 操作種別）の組に対して、Connection に対する操作が
 * 許可されるのは、操作が read かつユーザーが認証済みである場合、または操作が
 * create/update/delete かつユーザーが ADMINS グループに属する場合に限る。
 * 非管理者の書き込み操作は拒否される。
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  canPerformOperation,
  type AuthContext,
  type ConnectionOperation,
} from "./catalogAuthorization";

// --- Arbitraries ---

/** グループ名の生成（ADMINS を含む/含まないを制御可能） */
const groupNameArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

/** ADMINS を含まないグループ集合 */
const nonAdminGroupsArb = fc.array(
  groupNameArb.filter((g) => g !== "ADMINS"),
  { minLength: 0, maxLength: 5 }
);

/** ADMINS を含むグループ集合 */
const adminGroupsArb = nonAdminGroupsArb.map((groups) => [
  ...groups,
  "ADMINS",
]);

/** 操作種別 */
const operationArb: fc.Arbitrary<ConnectionOperation> = fc.constantFrom(
  "read",
  "create",
  "update",
  "delete"
);

/** write 操作のみ */
const writeOperationArb: fc.Arbitrary<ConnectionOperation> = fc.constantFrom(
  "create",
  "update",
  "delete"
);

/** 任意のグループ集合（ADMINS を含むかどうかはランダム） */
const anyGroupsArb = fc.array(
  fc.oneof(fc.constant("ADMINS"), groupNameArb),
  { minLength: 0, maxLength: 5 }
);

describe("catalogAuthorization - Property 6: カタログ認可の決定", () => {
  it("ADMINS グループのユーザーは read/create/update/delete すべて許可される", () => {
    fc.assert(
      fc.property(adminGroupsArb, operationArb, (groups, operation) => {
        const auth: AuthContext = { isAuthenticated: true, groups };
        expect(canPerformOperation(auth, operation)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("認証済み非管理者ユーザーは read のみ許可される", () => {
    fc.assert(
      fc.property(nonAdminGroupsArb, (groups) => {
        const auth: AuthContext = { isAuthenticated: true, groups };
        expect(canPerformOperation(auth, "read")).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("認証済み非管理者ユーザーの write 操作 (create/update/delete) は拒否される", () => {
    fc.assert(
      fc.property(nonAdminGroupsArb, writeOperationArb, (groups, operation) => {
        const auth: AuthContext = { isAuthenticated: true, groups };
        expect(canPerformOperation(auth, operation)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("未認証ユーザーはすべての操作が拒否される", () => {
    fc.assert(
      fc.property(anyGroupsArb, operationArb, (groups, operation) => {
        const auth: AuthContext = { isAuthenticated: false, groups };
        expect(canPerformOperation(auth, operation)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("認可決定は認証状態・グループ・操作のみに依存する（同一入力に対して冪等）", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        anyGroupsArb,
        operationArb,
        (isAuthenticated, groups, operation) => {
          const auth: AuthContext = { isAuthenticated, groups };
          const result1 = canPerformOperation(auth, operation);
          const result2 = canPerformOperation(auth, operation);
          expect(result1).toBe(result2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
