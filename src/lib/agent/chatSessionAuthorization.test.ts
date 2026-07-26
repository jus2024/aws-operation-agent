/**
 * Property-based test for ChatSession owner authorization
 *
 * Feature: aws-mcp-gateway-agent, Property: ChatSession owner 認可
 * Validates: Requirements 6.4
 *
 * ChatSession の `allow.owner()` 認可モデルを検証:
 * - 所有者（requestUserId === sessionOwnerUserId）のみアクセス許可
 * - 異なるユーザーはアクセス拒否（クロスユーザーアクセス拒否）
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { canAccessChatSession } from "./chatSessionAuthorization";

// --- Arbitraries ---

/** Cognito sub に相当するユーザー ID（UUID 形式風の文字列） */
const userIdArb = fc.uuid();

/** 異なる 2 つのユーザー ID のペア */
const distinctUserIdPairArb = fc
  .tuple(userIdArb, userIdArb)
  .filter(([a, b]) => a !== b);

describe("chatSessionAuthorization - ChatSession owner 認可", () => {
  it("同一ユーザー（owner）は常にアクセスが許可される", () => {
    fc.assert(
      fc.property(userIdArb, (userId) => {
        expect(canAccessChatSession(userId, userId)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("異なるユーザーは常にアクセスが拒否される（クロスユーザーアクセス拒否）", () => {
    fc.assert(
      fc.property(distinctUserIdPairArb, ([requestUserId, ownerUserId]) => {
        expect(canAccessChatSession(requestUserId, ownerUserId)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("認可判定は冪等である（同一入力に対して同一結果）", () => {
    fc.assert(
      fc.property(userIdArb, userIdArb, (requestUserId, ownerUserId) => {
        const result1 = canAccessChatSession(requestUserId, ownerUserId);
        const result2 = canAccessChatSession(requestUserId, ownerUserId);
        expect(result1).toBe(result2);
      }),
      { numRuns: 100 }
    );
  });

  it("認可判定は対称的ではない（A→B許可 ≠ B→A許可、A≠B の場合）", () => {
    fc.assert(
      fc.property(distinctUserIdPairArb, ([userA, userB]) => {
        // userA が ownerB のセッションにアクセスする → 拒否
        expect(canAccessChatSession(userA, userB)).toBe(false);
        // userB が ownerA のセッションにアクセスする → 拒否
        expect(canAccessChatSession(userB, userA)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
