/**
 * Property-based tests for authGate (認証ゲート)
 *
 * **Validates: Requirements 8.5, 10.2**
 *
 * Property 8: API Route の認証ゲート
 * - 未認証（有効な Bearer トークンなし）は 401 でプロキシせず、認証済みのみ後続へ進む
 *
 * Properties:
 * 1. No Authorization header (null) → not authenticated
 * 2. Authorization without "Bearer " prefix → not authenticated
 * 3. "Bearer " with empty token → not authenticated
 * 4. "Bearer " with non-empty token → authenticated
 * 5. isAuthenticated returns true iff extractBearerToken returns non-null
 *
 * Tag: Feature: gateway-direct-connect, Property 8: API Route の認証ゲート
 */

import fc from "fast-check";
import { extractBearerToken, isAuthenticated } from "./authGate";

// --- Generators ---

/** "Bearer " プレフィックスを持たない文字列（空文字列含む）。"Bearer " で始まらないことを保証。 */
const nonBearerHeader = fc
  .string({ minLength: 0, maxLength: 200 })
  .filter((s) => !s.startsWith("Bearer "));

/** 非空のトークン文字列（トリム後も非空） */
const nonEmptyToken = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** 空またはスペースのみのトークン文字列 */
const emptyOrWhitespaceToken = fc.oneof(
  fc.constant(""),
  fc.integer({ min: 1, max: 20 }).map((n) => " ".repeat(n))
);

// --- Properties ---

describe("Property 8: API Route の認証ゲート", () => {
  it("Property 8.1: null ヘッダー → extractBearerToken は null、isAuthenticated は false", () => {
    fc.assert(
      fc.property(fc.constant(null), (header) => {
        expect(extractBearerToken(header)).toBeNull();
        expect(isAuthenticated(header)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 8.2: 'Bearer ' プレフィックスなし → not authenticated", () => {
    fc.assert(
      fc.property(nonBearerHeader, (header) => {
        expect(extractBearerToken(header)).toBeNull();
        expect(isAuthenticated(header)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 8.3: 'Bearer ' + 空トークン（空文字/空白のみ）→ not authenticated", () => {
    fc.assert(
      fc.property(emptyOrWhitespaceToken, (token) => {
        const header = `Bearer ${token}`;
        expect(extractBearerToken(header)).toBeNull();
        expect(isAuthenticated(header)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 8.4: 'Bearer ' + 非空トークン → authenticated", () => {
    fc.assert(
      fc.property(nonEmptyToken, (token) => {
        const header = `Bearer ${token}`;
        const extracted = extractBearerToken(header);
        expect(extracted).not.toBeNull();
        expect(extracted!.length).toBeGreaterThan(0);
        expect(isAuthenticated(header)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 8.5: isAuthenticated(h) === true iff extractBearerToken(h) !== null", () => {
    // 全パターンの任意ヘッダーで双方向一致を検証
    const anyAuthHeader = fc.oneof(
      fc.constant(null),
      nonBearerHeader,
      emptyOrWhitespaceToken.map((t) => `Bearer ${t}`),
      nonEmptyToken.map((t) => `Bearer ${t}`)
    );

    fc.assert(
      fc.property(anyAuthHeader, (header) => {
        const token = extractBearerToken(header);
        const authed = isAuthenticated(header);

        if (token !== null) {
          expect(authed).toBe(true);
        } else {
          expect(authed).toBe(false);
        }

        // 逆方向も確認
        if (authed) {
          expect(token).not.toBeNull();
        } else {
          expect(token).toBeNull();
        }
      }),
      { numRuns: 100 }
    );
  });
});
