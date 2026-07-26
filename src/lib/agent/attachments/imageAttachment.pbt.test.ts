/**
 * Property-based tests for 画像添付バリデーション（imageAttachment）
 *
 * **Validates: Requirements 9.4, 9.5**
 *
 * Property 9: 画像添付バリデーション（型許可リスト・サイズ上限・合計予算・枚数上限）
 * - validateImageFile(m) が ok:true ⇔ (contentType ∈ ACCEPTED_IMAGE_TYPES ∧ sizeBytes <= IMAGE_MAX_BYTES)
 *   （型許可外 → unsupported_type、型許可だがサイズ超過 → file_too_large、例外は投げない＝全域）
 * - withinMessageBudget(sizes) が ok:true ⇔ sum(sizes) <= MESSAGE_IMAGE_BUDGET_BYTES
 *   （超過 → message_budget_exceeded）
 * - canAcceptMore(current, incoming) が ok:true ⇔ current + incoming <= IMAGE_MAX_COUNT
 *   （超過 → too_many）
 * - 3 述語はいずれも全域（例外を投げない）。境界値（==上限は有効・+1 は無効・0）を含む。
 *
 * Tag: Feature: ui-ux-enhancements, Property 9: 画像添付バリデーション（型許可リスト・サイズ上限・合計予算・枚数上限）
 */

import fc from "fast-check";
import {
  validateImageFile,
  withinMessageBudget,
  canAcceptMore,
  ACCEPTED_IMAGE_TYPES,
  IMAGE_MAX_BYTES,
  MESSAGE_IMAGE_BUDGET_BYTES,
  IMAGE_MAX_COUNT,
  ImageFileMeta,
} from "./imageAttachment";

// --- Generators ---

/** 許可された MIME タイプ */
const allowedType = fc.constantFrom(...ACCEPTED_IMAGE_TYPES);

/** 許可外の MIME タイプ（allowlist に含まれないもの） */
const disallowedType = fc
  .oneof(
    fc.constant("application/pdf"),
    fc.constant("image/bmp"),
    fc.constant("image/svg+xml"),
    fc.constant("text/plain"),
    fc.constant("image/tiff"),
    fc.constant(""),
    fc.constant("IMAGE/PNG"),
    fc.string({ maxLength: 30 })
  )
  .filter((t) => !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(t));

/** 任意の MIME タイプ（許可/許可外を混在） */
const anyType = fc.oneof(allowedType, disallowedType);

/**
 * サイズ（境界重視）: 0 / 上限-1 / 上限 / 上限+1 / 広域ランダム。
 */
const sizeBytes = fc.oneof(
  fc.constant(0),
  fc.constant(IMAGE_MAX_BYTES - 1),
  fc.constant(IMAGE_MAX_BYTES),
  fc.constant(IMAGE_MAX_BYTES + 1),
  fc.integer({ min: 0, max: IMAGE_MAX_BYTES * 2 })
);

/** 個々のサイズ要素（合計予算テスト用） */
const budgetElement = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0, max: MESSAGE_IMAGE_BUDGET_BYTES })
);

/** サイズ列（境界を含む合計になりやすいよう分割） */
const sizeList = fc.array(budgetElement, { maxLength: 6 });

/** 枚数（境界重視の非負整数） */
const count = fc.oneof(
  fc.constant(0),
  fc.constant(1),
  fc.constant(IMAGE_MAX_COUNT - 1),
  fc.constant(IMAGE_MAX_COUNT),
  fc.constant(IMAGE_MAX_COUNT + 1),
  fc.integer({ min: 0, max: IMAGE_MAX_COUNT * 3 })
);

// --- Property 9-a: validateImageFile ---

describe("Property 9: validateImageFile（型許可リスト × サイズ上限）", () => {
  it("ok:true ⇔ (contentType ∈ ACCEPTED_IMAGE_TYPES ∧ sizeBytes <= IMAGE_MAX_BYTES)", () => {
    fc.assert(
      fc.property(anyType, sizeBytes, (contentType, size) => {
        const meta: ImageFileMeta = {
          filename: "x.img",
          contentType,
          sizeBytes: size,
        };
        const result = validateImageFile(meta);
        const typeOk = (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(
          contentType
        );
        const sizeOk = size <= IMAGE_MAX_BYTES;
        expect(result.ok).toBe(typeOk && sizeOk);
      }),
      { numRuns: 200 }
    );
  });

  it("型許可外なら常に ok:false かつ reason === 'unsupported_type'（サイズに関わらず）", () => {
    fc.assert(
      fc.property(disallowedType, sizeBytes, (contentType, size) => {
        const result = validateImageFile({
          filename: "x.img",
          contentType,
          sizeBytes: size,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("unsupported_type");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("型は許可だがサイズ超過なら ok:false かつ reason === 'file_too_large'", () => {
    fc.assert(
      fc.property(
        allowedType,
        fc.integer({ min: IMAGE_MAX_BYTES + 1, max: IMAGE_MAX_BYTES * 3 }),
        (contentType, size) => {
          const result = validateImageFile({
            filename: "x.img",
            contentType,
            sizeBytes: size,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("file_too_large");
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("境界値: 型許可 ∧ sizeBytes === IMAGE_MAX_BYTES は有効 / +1 は無効", () => {
    fc.assert(
      fc.property(allowedType, (contentType) => {
        expect(
          validateImageFile({ filename: "x", contentType, sizeBytes: IMAGE_MAX_BYTES }).ok
        ).toBe(true);
        expect(
          validateImageFile({ filename: "x", contentType, sizeBytes: IMAGE_MAX_BYTES + 1 }).ok
        ).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Property 9-b: withinMessageBudget ---

describe("Property 9: withinMessageBudget（合計予算）", () => {
  it("ok:true ⇔ sum(sizes) <= MESSAGE_IMAGE_BUDGET_BYTES", () => {
    fc.assert(
      fc.property(sizeList, (sizes) => {
        const result = withinMessageBudget(sizes);
        const total = sizes.reduce((s, n) => s + n, 0);
        expect(result.ok).toBe(total <= MESSAGE_IMAGE_BUDGET_BYTES);
        if (!result.ok) {
          expect(result.reason).toBe("message_budget_exceeded");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("空配列（合計 0）は有効", () => {
    expect(withinMessageBudget([]).ok).toBe(true);
  });

  it("境界値: sum === 予算上限は有効 / +1 は無効", () => {
    expect(withinMessageBudget([MESSAGE_IMAGE_BUDGET_BYTES]).ok).toBe(true);
    expect(withinMessageBudget([MESSAGE_IMAGE_BUDGET_BYTES + 1]).ok).toBe(false);
    // 分割しても合計で判定される
    const half = Math.floor(MESSAGE_IMAGE_BUDGET_BYTES / 2);
    expect(
      withinMessageBudget([half, MESSAGE_IMAGE_BUDGET_BYTES - half]).ok
    ).toBe(true);
    expect(
      withinMessageBudget([half, MESSAGE_IMAGE_BUDGET_BYTES - half + 1]).ok
    ).toBe(false);
  });
});

// --- Property 9-c: canAcceptMore ---

describe("Property 9: canAcceptMore（枚数上限）", () => {
  it("ok:true ⇔ current + incoming <= IMAGE_MAX_COUNT", () => {
    fc.assert(
      fc.property(count, count, (current, incoming) => {
        const result = canAcceptMore(current, incoming);
        expect(result.ok).toBe(current + incoming <= IMAGE_MAX_COUNT);
        if (!result.ok) {
          expect(result.reason).toBe("too_many");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("境界値: current + incoming === IMAGE_MAX_COUNT は有効 / +1 は無効", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: IMAGE_MAX_COUNT }),
        (current) => {
          const incomingAtLimit = IMAGE_MAX_COUNT - current;
          expect(canAcceptMore(current, incomingAtLimit).ok).toBe(true);
          expect(canAcceptMore(current, incomingAtLimit + 1).ok).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
