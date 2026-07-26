/**
 * Property-based tests for scope persistence round-trip
 *
 * **Validates: Requirements 5.5**
 *
 * Property 13: スコープ永続化のラウンドトリップ
 * - 有効なスコープ値（readonly/readwrite/admin）が保存→読出しで同一値を維持
 * - enum 制約が有効値のみを許可し、データ破損がないことを検証
 * - 無効なスコープ値はスキーマレベルで拒否される
 *
 * Tag: Feature: aws-mcp-gateway-agent, Property 13: スコープ永続化のラウンドトリップ
 *
 * 本テストは Amplify sandbox デプロイなしで実行可能な純粋ロジックテストとして、
 * スキーマの enum 制約（バリデーション/シリアライゼーション層）のラウンドトリップを検証する。
 */

import fc from "fast-check";

// --- Schema definition (mirrors amplify/data/resource.ts operationScope enum) ---

/**
 * ChatSession の operationScope で許可される有効値の集合。
 * amplify/data/resource.ts の `a.enum(["readonly", "readwrite", "admin"])` と同一。
 */
const VALID_SCOPES = ["readonly", "readwrite", "admin"] as const;
type OperationScope = (typeof VALID_SCOPES)[number];

/**
 * スコープ値がスキーマの enum 制約に適合するかを判定する。
 * Amplify Data のスキーマ層で行われるバリデーションと等価。
 */
function isValidScope(value: unknown): value is OperationScope {
  return (
    typeof value === "string" &&
    VALID_SCOPES.includes(value as OperationScope)
  );
}

/**
 * スコープの保存（シリアライゼーション）をシミュレートする。
 * 有効な値はそのまま文字列として永続化される（DynamoDB の enum カラム）。
 * 無効な値は拒否される。
 */
function serializeScope(
  scope: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (!isValidScope(scope)) {
    return {
      ok: false,
      error: `Invalid operationScope: "${scope}". Must be one of: ${VALID_SCOPES.join(", ")}`,
    };
  }
  return { ok: true, value: scope };
}

/**
 * スコープの読出し（デシリアライゼーション）をシミュレートする。
 * DynamoDB から取得した文字列を enum 型に復元する。
 */
function deserializeScope(
  raw: string
): { ok: true; value: OperationScope } | { ok: false; error: string } {
  if (!isValidScope(raw)) {
    return {
      ok: false,
      error: `Corrupted operationScope in DB: "${raw}". Expected one of: ${VALID_SCOPES.join(", ")}`,
    };
  }
  return { ok: true, value: raw };
}

// --- Generators ---

/** 有効なスコープ値のジェネレータ */
const validScopeArb: fc.Arbitrary<OperationScope> = fc.constantFrom(
  ...VALID_SCOPES
);

/** 無効なスコープ値のジェネレータ（有効値を除外した任意文字列） */
const invalidScopeArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 50 })
  .filter((s) => !VALID_SCOPES.includes(s as OperationScope));

// --- Properties ---

describe("Property 13: スコープ永続化のラウンドトリップ", () => {
  it("有効なスコープ値は保存→読出しで同一値を維持する（ラウンドトリップ不変）", () => {
    fc.assert(
      fc.property(validScopeArb, (scope) => {
        // Write (serialize)
        const writeResult = serializeScope(scope);
        expect(writeResult.ok).toBe(true);
        if (!writeResult.ok) return;

        // Read (deserialize)
        const readResult = deserializeScope(writeResult.value);
        expect(readResult.ok).toBe(true);
        if (!readResult.ok) return;

        // Round-trip: 読み出した値が書き込んだ値と同一
        expect(readResult.value).toBe(scope);
      }),
      { numRuns: 100 }
    );
  });

  it("enum 制約は有効値セット {readonly, readwrite, admin} のみを許可する", () => {
    fc.assert(
      fc.property(validScopeArb, (scope) => {
        expect(isValidScope(scope)).toBe(true);
        // 有効値は正確に3種類のいずれか
        expect(VALID_SCOPES).toContain(scope);
      }),
      { numRuns: 100 }
    );
  });

  it("無効なスコープ値はシリアライゼーション層で拒否される", () => {
    fc.assert(
      fc.property(invalidScopeArb, (invalidScope) => {
        const result = serializeScope(invalidScope);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Invalid operationScope");
        }
      }),
      { numRuns: 100 }
    );
  });

  it("無効なスコープ値はデシリアライゼーション層で拒否される", () => {
    fc.assert(
      fc.property(invalidScopeArb, (invalidScope) => {
        const result = deserializeScope(invalidScope);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Corrupted operationScope");
        }
      }),
      { numRuns: 100 }
    );
  });

  it("有効値セットは正確に3要素（readonly, readwrite, admin）である", () => {
    // この不変条件はスキーマの定義を検証
    expect(VALID_SCOPES).toHaveLength(3);
    expect(VALID_SCOPES).toContain("readonly");
    expect(VALID_SCOPES).toContain("readwrite");
    expect(VALID_SCOPES).toContain("admin");
  });

  it("ラウンドトリップの冪等性: 複数回の保存→読出しでも値が変化しない", () => {
    fc.assert(
      fc.property(
        validScopeArb,
        fc.integer({ min: 2, max: 5 }),
        (scope, iterations) => {
          let current: string = scope;

          for (let i = 0; i < iterations; i++) {
            const writeResult = serializeScope(current);
            expect(writeResult.ok).toBe(true);
            if (!writeResult.ok) return;

            const readResult = deserializeScope(writeResult.value);
            expect(readResult.ok).toBe(true);
            if (!readResult.ok) return;

            current = readResult.value;
          }

          // N 回のラウンドトリップ後も元の値と同一
          expect(current).toBe(scope);
        }
      ),
      { numRuns: 100 }
    );
  });
});
