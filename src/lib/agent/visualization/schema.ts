/**
 * Visualization_Schema — 可視化ペイロードの検証 / 正規化 / アクセシブル変換
 *
 * `accessGates.ts` / `roleConfigValidation.ts` と同じ「UI ロジックを純粋関数に
 * 切り出す」パターンを踏襲する。React hooks や API コール（Amplify Data /
 * CopilotKit）に依存しない、インフラ非依存の純粋モジュールである。
 *
 * Agent（`agents/`）が AG-UI プロトコルで送出する `Visualization_Payload` を、
 * フロント（Generative UI レンダラ）が描画する前に本モジュールで検証・正規化する。
 * `parseVisualization` は例外を投げない全域関数であり、非適合・非対応型を
 * テキストフォールバック（reason 付き）へ分類する。
 *
 * 対応する可視化タイプは bar / line / pie / table の 4 種。
 *
 * Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 1.8
 * Design Correctness Properties: 1（round-trip）, 2（parse 全域）, 3（accessible）
 */

/** 対応する可視化タイプ（Req 1.2）。 */
export type VisualizationType = "bar" | "line" | "pie" | "table";

/** 対応可視化タイプの集合（`parseVisualization` の分類に使用）。 */
export const SUPPORTED_VISUALIZATION_TYPES: readonly VisualizationType[] = [
  "bar",
  "line",
  "pie",
  "table",
] as const;

/**
 * bar / pie で用いるカテゴリ系列の 1 要素。
 * `label`（カテゴリ名）と `value`（有限数）を持つ。
 */
export interface CategoryDatum {
  label: string;
  value: number;
}

/** line の 1 点。`x` はカテゴリ/数値、`y` は有限数。 */
export interface LinePoint {
  x: string | number;
  y: number;
}

/** line で用いる 1 系列。`name`（系列名）と時系列/連続の `points`。 */
export interface LineSeries {
  name: string;
  points: LinePoint[];
}

/**
 * 正規化前の可視化ペイロード（Agent / フロントで合意された構造）。
 *
 * `series` は type により意味が異なる:
 *   - bar / pie: `CategoryDatum[]`
 *   - line:      `LineSeries[]`
 *   - table:     データは `columns` / `rows` が持つ（`series` は空配列を運ぶ）
 *
 * `columns` / `rows` は table のときにデータを保持する。
 */
export interface VisualizationPayload {
  type: VisualizationType;
  title: string;
  series: CategoryDatum[] | LineSeries[];
  columns?: string[];
  rows?: Array<Array<string | number>>;
}

/**
 * 正規化済み（正準形）の可視化ペイロード。
 *
 * 構造的には `VisualizationPayload` と同一であり、`isValidVisualization` を
 * 常に満たす（round-trip; Req 1.6）。正準形では:
 *   - 型に無関係なフィールドを取り除く（bar/pie/line は columns/rows を持たない、
 *     table は series を空配列にする）
 *   - `-0` を `0` に正準化する
 *   - 余分なプロパティを落とし、宣言フィールドのみの新規オブジェクトを構成する
 */
export type NormalizedVisualizationPayload = VisualizationPayload;

/** `parseVisualization` の結果。成功なら正規化済みペイロード、失敗なら理由付き。 */
export type VisualizationParseResult =
  | { ok: true; payload: NormalizedVisualizationPayload }
  | { ok: false; reason: "invalid_schema" | "unsupported_type"; raw: unknown };

// --- 内部ヘルパー（純粋・非公開） ---

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** セル値は文字列、または有限数のみを許可する。 */
function isCell(x: unknown): x is string | number {
  return typeof x === "string" || isFiniteNumber(x);
}

/** `-0` を `0` に畳み込む（round-trip の等価比較を安定させる）。 */
function canonNumber(n: number): number {
  return n === 0 ? 0 : n;
}

/** カテゴリ系列（bar/pie）の形状判定。空配列は真（vacuously）。 */
function isCategorySeries(s: unknown): s is CategoryDatum[] {
  return (
    Array.isArray(s) &&
    s.every(
      (d) =>
        isPlainObject(d) &&
        typeof d.label === "string" &&
        isFiniteNumber(d.value),
    )
  );
}

/** line 系列の形状判定。空配列は真（vacuously）。 */
function isLineSeriesArray(s: unknown): s is LineSeries[] {
  return (
    Array.isArray(s) &&
    s.every(
      (series) =>
        isPlainObject(series) &&
        typeof series.name === "string" &&
        Array.isArray(series.points) &&
        series.points.every(
          (pt) =>
            isPlainObject(pt) &&
            (typeof pt.x === "string" || isFiniteNumber(pt.x)) &&
            isFiniteNumber(pt.y),
        ),
    )
  );
}

/** table の columns / rows 形状判定（各行長は columns 長と一致）。 */
function isValidTable(
  columns: unknown,
  rows: unknown,
): columns is string[] {
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) {
    return false;
  }
  if (!Array.isArray(rows)) return false;
  return rows.every(
    (row) =>
      Array.isArray(row) &&
      row.length === columns.length &&
      row.every((cell) => isCell(cell)),
  );
}

/**
 * スキーマ適合判定（純粋述語 / 型ガード）。
 *
 * type ごとに以下を要求する:
 *   - bar / pie: `series` が `CategoryDatum[]`（columns/rows は任意・無視）
 *   - line:      `series` が `LineSeries[]`
 *   - table:     `columns` が `string[]`、`rows` が各行長 = columns 長のセル配列。
 *                `series` は配列であること（正準形では空配列）
 *
 * round-trip の再検証に使用する（Req 1.6）。
 */
export function isValidVisualization(p: unknown): p is VisualizationPayload {
  if (!isPlainObject(p)) return false;
  if (typeof p.title !== "string") return false;

  switch (p.type) {
    case "bar":
    case "pie":
      return isCategorySeries(p.series);
    case "line":
      return isLineSeriesArray(p.series);
    case "table":
      return Array.isArray(p.series) && isValidTable(p.columns, p.rows);
    default:
      return false;
  }
}

/**
 * 検証済み入力を正準形へ正規化する（round-trip の対象; Req 1.6）。
 *
 * 型に応じてデータフィールドのみを保持し、余分なプロパティを落とす。
 * 数値は `-0` を `0` に畳み込む。正規化は冪等である。
 */
export function normalizeVisualization(
  p: VisualizationPayload,
): NormalizedVisualizationPayload {
  const title = p.title;

  switch (p.type) {
    case "bar":
    case "pie": {
      const series = (p.series as CategoryDatum[]).map((d) => ({
        label: d.label,
        value: canonNumber(d.value),
      }));
      return { type: p.type, title, series };
    }
    case "line": {
      const series = (p.series as LineSeries[]).map((s) => ({
        name: s.name,
        points: s.points.map((pt) => ({
          x: typeof pt.x === "number" ? canonNumber(pt.x) : pt.x,
          y: canonNumber(pt.y),
        })),
      }));
      return { type: "line", title, series };
    }
    case "table": {
      const columns = [...(p.columns ?? [])];
      const rows = (p.rows ?? []).map((row) =>
        row.map((cell) => (typeof cell === "number" ? canonNumber(cell) : cell)),
      );
      return { type: "table", title, series: [], columns, rows };
    }
  }
}

/**
 * 任意の入力を検証し、対応型なら正規化して返す全域関数（例外を投げない）。
 *
 * 分類（Design Property 2）:
 *   - type が文字列でない / オブジェクトでない        → invalid_schema
 *   - type が対応 4 種でない文字列                    → unsupported_type
 *   - 対応型だがスキーマ非適合                        → invalid_schema
 *   - 対応型かつ適合                                  → ok: true（正規化済み）
 *
 * Requirements: 1.1, 1.4, 1.5
 */
export function parseVisualization(raw: unknown): VisualizationParseResult {
  if (!isPlainObject(raw) || typeof raw.type !== "string") {
    return { ok: false, reason: "invalid_schema", raw };
  }

  if (!SUPPORTED_VISUALIZATION_TYPES.includes(raw.type as VisualizationType)) {
    return { ok: false, reason: "unsupported_type", raw };
  }

  if (!isValidVisualization(raw)) {
    return { ok: false, reason: "invalid_schema", raw };
  }

  return { ok: true, payload: normalizeVisualization(raw) };
}

/**
 * 可視化の全データ値を読み上げ可能なテキスト表へ変換する（Req 1.7, 1.8）。
 *
 * `caption` にはタイトルを含め、`rows` には可視化が保持する全データ値を含める。
 * チャート型（bar/line/pie）についても下地データを表形式で取得可能にする。
 */
export function toAccessibleTable(p: NormalizedVisualizationPayload): {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
} {
  switch (p.type) {
    case "bar":
    case "pie": {
      const series = p.series as CategoryDatum[];
      return {
        caption: p.title,
        columns: ["ラベル", "値"],
        rows: series.map((d) => [d.label, d.value]),
      };
    }
    case "line": {
      const series = p.series as LineSeries[];
      const rows: Array<Array<string | number>> = [];
      for (const s of series) {
        for (const pt of s.points) {
          rows.push([s.name, pt.x, pt.y]);
        }
      }
      return { caption: p.title, columns: ["系列", "X", "Y"], rows };
    }
    case "table":
      return {
        caption: p.title,
        columns: [...(p.columns ?? [])],
        rows: (p.rows ?? []).map((row) => [...row]),
      };
  }
}
