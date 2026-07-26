/**
 * Property-based tests for Visualization_Schema (schema.ts)
 *
 * このファイルは Visualization スキーマの純粋関数群に対する共有 PBT スイートである。
 * Correctness Properties（design.md）ごとに、独立した describe ブロックを追加していく:
 *   - Property 1: validate/normalize ラウンドトリップ（task 3.2）
 *   - Property 2: parse は全域でありフォールバックへ分類（task 3.3）
 *   - Property 3: アクセシブルな代替はタイトルと全データ値を含む（task 3.4 / このブロック）
 *
 * 各ブロックはジェネレータを describe 内にローカル定義し、他ブロックと衝突しないよう分離する。
 *
 * 実行: `npm test`（vitest run）、`fast-check` を `{ numRuns: 100 }` 以上で反復する。
 */

import fc from "fast-check";
import {
  isValidVisualization,
  normalizeVisualization,
  parseVisualization,
  SUPPORTED_VISUALIZATION_TYPES,
  toAccessibleTable,
  type CategoryDatum,
  type LineSeries,
  type VisualizationPayload,
  type VisualizationType,
} from "./schema";

// ============================================================================
// Property 3: アクセシブルな代替はタイトルと全データ値を含む
//
// Feature: ui-ux-enhancements, Property 3: アクセシブルな代替はタイトルと全データ値を含む
// **Validates: Requirements 1.7, 1.8**
//
// For all Schema 適合の Visualization_Payload p について、
// toAccessibleTable(normalizeVisualization(p)) の出力は
//   - caption に p.title を含み、
//   - p が保持するすべてのデータ値（各系列値・各セル値）を rows 内に含む。
// チャート型（bar/line/pie）についても下地データ値が表形式で取得可能である。
// ============================================================================

describe("Feature: ui-ux-enhancements, Property 3: アクセシブルな代替はタイトルと全データ値を含む", () => {
  // --- ローカルジェネレータ（このブロックに閉じる） ---

  /** 有限数（0 / -0 / 大きな正負を含むエッジ）。isValidVisualization を満たす値のみ。 */
  const finiteNumber: fc.Arbitrary<number> = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ min: -1e12, max: 1e12, noNaN: true, noDefaultInfinity: true }),
    fc.constant(0),
    fc.constant(-0),
    fc.constant(1_000_000_000_000),
  );

  /** ラベル/名前/セル文字列（空文字・Unicode を含む）。 */
  const label: fc.Arbitrary<string> = fc.string();

  /** bar / pie のカテゴリ系列（空系列を含む）。 */
  const categorySeries: fc.Arbitrary<CategoryDatum[]> = fc.array(
    fc.record({ label, value: finiteNumber }),
    { maxLength: 8 },
  );

  const barOrPiePayload: fc.Arbitrary<VisualizationPayload> = fc.record({
    type: fc.constantFrom<"bar" | "pie">("bar", "pie"),
    title: fc.string(),
    series: categorySeries,
  });

  /** line 系列（点の x は文字列/数値、y は有限数。空系列・空点列を含む）。 */
  const lineSeriesArb: fc.Arbitrary<LineSeries[]> = fc.array(
    fc.record({
      name: label,
      points: fc.array(
        fc.record({
          x: fc.oneof(fc.string(), finiteNumber),
          y: finiteNumber,
        }),
        { maxLength: 8 },
      ),
    }),
    { maxLength: 5 },
  );

  const linePayload: fc.Arbitrary<VisualizationPayload> = fc.record({
    type: fc.constant<"line">("line"),
    title: fc.string(),
    series: lineSeriesArb,
  });

  /** table（columns 長 = 各 row 長を保証）。空テーブルを含む。 */
  const cell: fc.Arbitrary<string | number> = fc.oneof(fc.string(), finiteNumber);

  const tablePayload: fc.Arbitrary<VisualizationPayload> = fc
    .array(label, { maxLength: 6 })
    .chain((columns) =>
      fc.record({
        type: fc.constant<"table">("table"),
        title: fc.string(),
        series: fc.constant<CategoryDatum[]>([]),
        columns: fc.constant(columns),
        rows: fc.array(
          fc.array(cell, { minLength: columns.length, maxLength: columns.length }),
          { maxLength: 10 },
        ),
      }),
    );

  /** Schema 適合の任意ペイロード（4 型混在）。 */
  const validPayload: fc.Arbitrary<VisualizationPayload> = fc.oneof(
    barOrPiePayload,
    linePayload,
    tablePayload,
  );

  /**
   * 数値の SameValueZero 相当を考慮しつつ、値がセル群に含まれるか判定する。
   * normalizeVisualization が -0 を 0 に畳み込むため、比較対象も正規化済み値を用いる。
   */
  const includesValue = (
    cells: Array<string | number>,
    value: string | number,
  ): boolean => cells.some((c) => Object.is(c === 0 ? 0 : c, value === 0 ? 0 : value));

  /** 正規化済みペイロードから「含まれるべきデータ値」を列挙する。 */
  const expectedDataValues = (
    p: VisualizationPayload,
  ): Array<string | number> => {
    switch (p.type) {
      case "bar":
      case "pie": {
        const series = p.series as CategoryDatum[];
        return series.flatMap((d) => [d.label, d.value]);
      }
      case "line": {
        const series = p.series as LineSeries[];
        return series.flatMap((s) =>
          s.points.flatMap((pt) => [s.name, pt.x, pt.y]),
        );
      }
      case "table":
        return (p.rows ?? []).flat();
    }
  };

  it("生成器は必ず Schema 適合ペイロードを生成する（前提条件）", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        expect(isValidVisualization(p)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("caption は title を含み、全データ値が rows 内に現れる", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        const normalized = normalizeVisualization(p);
        const result = toAccessibleTable(normalized);

        // caption はタイトルを含む（Req 1.7）
        expect(result.caption).toContain(normalized.title);

        // rows を平坦化した全セル
        const flatCells = result.rows.flat();

        // 正規化済みペイロードが保持する全データ値が rows に現れる（Req 1.7, 1.8）
        for (const value of expectedDataValues(normalized)) {
          expect(includesValue(flatCells, value)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("チャート型（bar/line/pie）でもデータがあれば表形式で取得できる", () => {
    const chartWithData = fc.oneof(
      barOrPiePayload.filter(
        (p) => (p.series as CategoryDatum[]).length > 0,
      ),
      linePayload.filter((p) =>
        (p.series as LineSeries[]).some((s) => s.points.length > 0),
      ),
    );

    fc.assert(
      fc.property(chartWithData, (p) => {
        const result = toAccessibleTable(normalizeVisualization(p));
        // 下地データが存在する場合、rows は空でない（表形式で取得可能; Req 1.8）
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.columns.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ============================================================================
// Property 2: parse は全域であり非適合は必ずフォールバックへ分類される
//
// **Validates: Requirements 1.1, 1.4, 1.5**
//
// Tag: Feature: ui-ux-enhancements, Property 2: parse は全域であり非適合は必ず
//      フォールバックへ分類される
//
// 任意入力 x に対し parseVisualization(x) は例外を投げず、
//  (a) Schema 適合 & 対応型 → ok:true（正規化済み、type ∈ bar/line/pie/table）
//  (b) 対応型でない          → ok:false, reason:"unsupported_type"
//  (c) Schema 非適合         → ok:false, reason:"invalid_schema"
// を返す。ok:true の payload は isValidVisualization を満たす。
// ============================================================================

describe("Feature: ui-ux-enhancements, Property 2: parse は全域であり非適合は必ずフォールバックへ分類される", () => {
  // --- ローカルジェネレータ（このブロックに閉じる） ---

  /** 有限数（NaN / ±Infinity を除外）。isFiniteNumber と整合させる。 */
  const finiteNumber: fc.Arbitrary<number> = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ min: -1e12, max: 1e12, noNaN: true, noDefaultInfinity: true }),
    fc.constant(0),
    fc.constant(-0),
  );

  /** ラベル/タイトル文字列（空文字・Unicode を含む）。 */
  const label: fc.Arbitrary<string> = fc.string();

  /** セル値: 文字列または有限数（isCell と整合）。 */
  const cell = fc.oneof(label, finiteNumber);

  /** bar / pie のカテゴリ系列（空系列を含む）。 */
  const categorySeries = fc.array(
    fc.record({ label, value: finiteNumber }),
    { maxLength: 8 },
  );

  /** line 系列（空系列・空 points を含む）。 */
  const lineSeriesArray = fc.array(
    fc.record({
      name: label,
      points: fc.array(
        fc.record({ x: fc.oneof(label, finiteNumber), y: finiteNumber }),
        { maxLength: 8 },
      ),
    }),
    { maxLength: 5 },
  );

  /** table（各行長 = columns 長）を含む Schema 適合ペイロード生成器。 */
  const tablePayload = fc
    .array(label, { maxLength: 5 })
    .chain((columns) =>
      fc.record({
        type: fc.constant("table" as const),
        title: label,
        series: fc.constant([] as never[]),
        columns: fc.constant(columns),
        rows: fc.array(
          fc.array(cell, {
            minLength: columns.length,
            maxLength: columns.length,
          }),
          { maxLength: 6 },
        ),
      }),
    );

  /** Schema 適合かつ対応型のペイロード（bar / line / pie / table 混在）。 */
  const validPayload: fc.Arbitrary<unknown> = fc.oneof(
    fc.record({
      type: fc.constantFrom("bar" as const, "pie" as const),
      title: label,
      series: categorySeries,
    }),
    fc.record({
      type: fc.constant("line" as const),
      title: label,
      series: lineSeriesArray,
    }),
    tablePayload,
  );

  /** type が文字列だが対応 4 種でないペイロード（→ unsupported_type 期待）。 */
  const unsupportedTypePayload: fc.Arbitrary<unknown> = fc
    .string()
    .filter(
      (s) => !SUPPORTED_VISUALIZATION_TYPES.includes(s as VisualizationType),
    )
    .chain((type) =>
      fc.record({
        type: fc.constant(type),
        title: label,
        series: fc.anything(),
      }),
    );

  /** 対応型だがスキーマ非適合なペイロード（→ invalid_schema 期待）。 */
  const invalidStructurePayload: fc.Arbitrary<unknown> = fc.oneof(
    // bar/line/pie だが series が壊れている
    fc.record({
      type: fc.constantFrom("bar", "line", "pie"),
      title: label,
      series: fc.oneof(
        fc.constant(undefined),
        fc.integer(),
        fc.string(),
        // 要素の形状が不正な非空配列（空配列は vacuously valid になるため除外）
        fc.array(fc.record({ label: fc.integer() }), { minLength: 1 }),
      ),
    }),
    // table だが rows の行長が columns 長と不一致
    fc.record({
      type: fc.constant("table"),
      title: label,
      columns: fc.array(label, { minLength: 1, maxLength: 4 }),
      rows: fc.constant([[1, 2, 3, 4, 5, 6, 7]]),
    }),
    // title が文字列でない
    fc.record({
      type: fc.constantFrom("bar", "line", "pie", "table"),
      title: fc.oneof(fc.integer(), fc.constant(null), fc.constant(undefined)),
      series: categorySeries,
    }),
  );

  /** 構造不明・非オブジェクトを含む任意入力（全分類を混在）。 */
  const arbitraryInput: fc.Arbitrary<unknown> = fc.oneof(
    fc.anything(),
    fc.constant(null),
    fc.constant(undefined),
    fc.integer(),
    fc.string(),
    fc.boolean(),
    fc.array(fc.anything()),
    validPayload,
    unsupportedTypePayload,
    invalidStructurePayload,
  );

  it("任意入力に対し例外を投げず well-formed な結果を返す（ok:true payload | ok:false reason+raw）", () => {
    fc.assert(
      fc.property(arbitraryInput, (x) => {
        const result = parseVisualization(x);

        expect(result).toBeDefined();
        expect(typeof result.ok).toBe("boolean");

        if (result.ok) {
          // (a) 成功時は正規化済みペイロードを持ち、対応 4 種のいずれか
          expect(result).toHaveProperty("payload");
          expect(SUPPORTED_VISUALIZATION_TYPES).toContain(result.payload.type);
          // 正規化ペイロードは再検証（isValidVisualization）を満たす
          expect(isValidVisualization(result.payload)).toBe(true);
        } else {
          // (b)(c) 失敗時は分類理由と raw を持つ
          expect(["invalid_schema", "unsupported_type"]).toContain(
            result.reason,
          );
          expect(result).toHaveProperty("raw");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("スキーマ適合かつ対応型の入力は常に ok:true を返す", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        const result = parseVisualization(p);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(SUPPORTED_VISUALIZATION_TYPES).toContain(result.payload.type);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("type が対応 4 種でない文字列の入力は常に unsupported_type を返す", () => {
    fc.assert(
      fc.property(unsupportedTypePayload, (p) => {
        const result = parseVisualization(p);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("unsupported_type");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("対応型だがスキーマ非適合の入力は常に invalid_schema を返す", () => {
    fc.assert(
      fc.property(invalidStructurePayload, (p) => {
        const result = parseVisualization(p);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("invalid_schema");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("オブジェクトでない / type が文字列でない入力は invalid_schema を返す", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.string(),
          fc.boolean(),
          fc.array(fc.anything()),
          fc.record({ title: label }), // type 欠落
          fc.record({ type: fc.integer(), title: label }), // type が数値
        ),
        (x) => {
          const result = parseVisualization(x);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("invalid_schema");
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ============================================================================
// Property 1: validate/normalize ラウンドトリップ
//
// Feature: ui-ux-enhancements, Property 1: validate/normalize ラウンドトリップ
// **Validates: Requirements 1.6**
//
// Schema 適合の Visualization_Payload p について:
//   (a) normalizeVisualization(p) は再び isValidVisualization を満たす（round-trip）。
//   (b) 正規化は type と全データ値を保存する（-0 は 0 と同一視）。
//       比較は normalize 内部を再利用せず、独立した参照正準化で行う。
//   (c) 正規化は冪等である: normalize(normalize(p)) は normalize(p) と深く等しい。
// ============================================================================

describe("Feature: ui-ux-enhancements, Property 1: validate/normalize ラウンドトリップ", () => {
  // --- ローカルジェネレータ / ヘルパー（このブロックに閉じる） ---

  /** 有限数（0 / -0 / 大きな正負を含むエッジ）。isValidVisualization を満たす値のみ。 */
  const finiteNumber: fc.Arbitrary<number> = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ min: -1e12, max: 1e12, noNaN: true, noDefaultInfinity: true }),
    fc.constant(0),
    fc.constant(-0),
    fc.constant(1e308),
    fc.constant(-1e308),
  );

  /** ラベル/名前/セル文字列（空文字・Unicode を含む）。 */
  const label: fc.Arbitrary<string> = fc.oneof(
    fc.string(),
    fc.constant(""),
    fc.constantFrom("😀", "日本語", "\u0000", "混在ABC123", "🚀🌟", "©®™"),
  );

  /** bar / pie のカテゴリ系列（空系列を含む）。 */
  const categorySeries: fc.Arbitrary<CategoryDatum[]> = fc.array(
    fc.record({ label, value: finiteNumber }),
    { maxLength: 8 },
  );

  const barOrPiePayload: fc.Arbitrary<VisualizationPayload> = fc.record({
    type: fc.constantFrom<"bar" | "pie">("bar", "pie"),
    title: label,
    series: categorySeries,
  });

  /** line 系列（点の x は文字列/数値、y は有限数。空系列・空点列を含む）。 */
  const lineSeriesArb: fc.Arbitrary<LineSeries[]> = fc.array(
    fc.record({
      name: label,
      points: fc.array(
        fc.record({
          x: fc.oneof(label, finiteNumber),
          y: finiteNumber,
        }),
        { maxLength: 8 },
      ),
    }),
    { maxLength: 5 },
  );

  const linePayload: fc.Arbitrary<VisualizationPayload> = fc.record({
    type: fc.constant<"line">("line"),
    title: label,
    series: lineSeriesArb,
  });

  /** table（columns 長 = 各 row 長を保証）。空テーブル（0 列 → 長さ 0 の行）を含む。 */
  const cell: fc.Arbitrary<string | number> = fc.oneof(label, finiteNumber);

  const tablePayload: fc.Arbitrary<VisualizationPayload> = fc
    .array(label, { maxLength: 6 })
    .chain((columns) =>
      fc.record({
        type: fc.constant<"table">("table"),
        title: label,
        series: fc.constant<CategoryDatum[]>([]),
        columns: fc.constant(columns),
        rows: fc.array(
          fc.array(cell, { minLength: columns.length, maxLength: columns.length }),
          { maxLength: 10 },
        ),
      }),
    );

  /** Schema 適合の任意ペイロード（4 型混在）。 */
  const validPayload: fc.Arbitrary<VisualizationPayload> = fc.oneof(
    barOrPiePayload,
    linePayload,
    tablePayload,
  );

  /**
   * 独立した参照正準化（normalize 内部を再利用しない）。
   * -0 を 0 に畳み込むだけの最小限の正準化を行い、比較の安定に用いる。
   */
  const refCanonNumber = (n: number): number => (n === 0 ? 0 : n);

  /** 値（文字列/数値）を参照正準化する。 */
  const refCanonValue = (v: string | number): string | number =>
    typeof v === "number" ? refCanonNumber(v) : v;

  /**
   * ペイロードが保持する全データ値を、順序を保って列挙する（独立実装）。
   * type / 系列構造ごとに、正準化した値の平坦な列を返す。
   */
  const extractValues = (p: VisualizationPayload): Array<string | number> => {
    switch (p.type) {
      case "bar":
      case "pie":
        return (p.series as CategoryDatum[]).flatMap((d) => [
          d.label,
          refCanonValue(d.value),
        ]);
      case "line":
        return (p.series as LineSeries[]).flatMap((s) =>
          s.points.flatMap((pt) => [
            s.name,
            refCanonValue(pt.x),
            refCanonValue(pt.y),
          ]),
        );
      case "table":
        return (p.rows ?? []).flatMap((row) => row.map(refCanonValue));
    }
  };

  /** SameValueZero を Object.is ベースへ寄せた深い等価比較（NaN 非対象）。 */
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (typeof a === "number" && typeof b === "number") {
      return Object.is(refCanonNumber(a), refCanonNumber(b));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      return (
        a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
      );
    }
    if (
      typeof a === "object" &&
      a !== null &&
      typeof b === "object" &&
      b !== null
    ) {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      const ak = Object.keys(ao);
      const bk = Object.keys(bo);
      return (
        ak.length === bk.length &&
        ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k)) &&
        ak.every((k) => deepEqual(ao[k], bo[k]))
      );
    }
    return Object.is(a, b);
  };

  it("生成器は必ず Schema 適合ペイロードを生成する（前提条件）", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        expect(isValidVisualization(p)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("正規化後のペイロードは再び isValidVisualization を満たす（round-trip; Req 1.6）", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        const normalized = normalizeVisualization(p);
        expect(isValidVisualization(normalized)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("正規化は type と全データ値を保存する（独立参照正準化で比較; Req 1.6）", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        const normalized = normalizeVisualization(p);
        // type は不変
        expect(normalized.type).toBe(p.type);
        // 全データ値が順序を保って保存される（-0 は 0 と同一視）
        expect(extractValues(normalized)).toStrictEqual(extractValues(p));
        // table の列見出しも保存される
        if (p.type === "table") {
          expect(normalized.columns ?? []).toStrictEqual(p.columns ?? []);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("正規化は冪等である: normalize(normalize(p)) は normalize(p) と深く等しい（Req 1.6）", () => {
    fc.assert(
      fc.property(validPayload, (p) => {
        const once = normalizeVisualization(p);
        const twice = normalizeVisualization(once);
        expect(deepEqual(twice, once)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
