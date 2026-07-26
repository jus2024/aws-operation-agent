/**
 * Property-based tests for attemptConnectionChange (accessGates)
 *
 * **Validates: Requirements 4.4**
 *
 * Property 12: セッション-接続束縛の不変性
 * - アクティブセッション中（activeSessionId !== null）の接続変更操作は状態を一切変更しない
 * - セッション非アクティブ時（activeSessionId === null）は boundConnectionId が更新される
 *
 * Tag: Feature: aws-mcp-gateway-agent, Property 12: セッション-接続束縛の不変性
 */

import fc from "fast-check";
import { attemptConnectionChange, SessionState } from "./accessGates";

// --- Generators ---

/** 非空のセッション ID（アクティブセッション） */
const activeSessionId = fc.string({ minLength: 1, maxLength: 100 });

/** 非空の接続 ID */
const connectionId = fc.string({ minLength: 1, maxLength: 100 });

/** アクティブセッションを持つ状態 */
const activeSessionState: fc.Arbitrary<SessionState> = fc.record({
  activeSessionId: activeSessionId,
  boundConnectionId: fc.oneof(fc.constant(null), connectionId),
});

/** セッション非アクティブの状態 */
const inactiveSessionState: fc.Arbitrary<SessionState> = fc.record({
  activeSessionId: fc.constant(null),
  boundConnectionId: fc.oneof(fc.constant(null), connectionId),
});

// --- Properties ---

describe("Property 12: セッション-接続束縛の不変性", () => {
  it("アクティブセッション中は接続変更操作後も状態が完全に不変", () => {
    fc.assert(
      fc.property(activeSessionState, connectionId, (state, newConnectionId) => {
        const result = attemptConnectionChange(state, newConnectionId);

        // 返却された状態が入力状態と完全に同一であること
        expect(result).toStrictEqual(state);
        expect(result.activeSessionId).toBe(state.activeSessionId);
        expect(result.boundConnectionId).toBe(state.boundConnectionId);
      }),
      { numRuns: 100 }
    );
  });

  it("セッション非アクティブ時は boundConnectionId が newConnectionId に更新される", () => {
    fc.assert(
      fc.property(inactiveSessionState, connectionId, (state, newConnectionId) => {
        const result = attemptConnectionChange(state, newConnectionId);

        // boundConnectionId が新しい値に更新されること
        expect(result.boundConnectionId).toBe(newConnectionId);
        // activeSessionId は null のまま
        expect(result.activeSessionId).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});
