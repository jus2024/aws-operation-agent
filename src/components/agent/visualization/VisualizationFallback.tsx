"use client";

/**
 * VisualizationFallback — 可視化のテキストフォールバック表示
 *
 * `parseVisualization()`（`src/lib/agent/visualization/schema.ts`）が
 * `ok: false` を返したとき、すなわち可視化ペイロードが以下のいずれかの場合に
 * 描画する。
 *   - `unsupported_type`: Schema 上は妥当だが、対応する可視化タイプ
 *     （bar / line / pie / table）ではない（Requirement 1.4）
 *   - `invalid_schema`: Visualization_Schema の検証に失敗した（Requirement 1.5）
 *
 * いずれの場合も、生ペイロードをテキスト / 簡易表として提示し、
 * 「未対応 / 検証失敗」を示す注記を添える。これにより、可視化として描画
 * できなくても情報を失わず、アシスタントメッセージの残りの描画を中断させない
 * （Requirement 1.5）。
 *
 * 本コンポーネントは純粋な表示コンポーネントであり、CopilotKit / Amplify Data /
 * React hooks に依存しない（`amplify-frontend` ルール: UI とインフラの分離）。
 *
 * Requirements: 1.4, 1.5
 */

/** フォールバックの理由。`parseVisualization` の `reason` と一致する。 */
export type VisualizationFallbackReason = "invalid_schema" | "unsupported_type";

export interface VisualizationFallbackProps {
  /** 描画に失敗した生の可視化ペイロード（構造は不明・不正の可能性がある）。 */
  raw: unknown;
  /** フォールバックに至った理由。注記の文言を決定する。 */
  reason: VisualizationFallbackReason;
}

/** 理由ごとの利用者向け注記文言（Requirement 1.4, 1.5）。 */
const REASON_LABELS: Record<VisualizationFallbackReason, string> = {
  unsupported_type: "この可視化タイプは未対応です。データをそのまま表示します。",
  invalid_schema: "可視化データの検証に失敗しました。データをそのまま表示します。",
};

/**
 * 生ペイロードを人間可読なテキストへ安全に変換する（例外を投げない）。
 * 循環参照や BigInt などで `JSON.stringify` が失敗した場合は `String(raw)`
 * にフォールバックする。
 */
function rawToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(
      raw,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
  } catch {
    return String(raw);
  }
}

/** 生ペイロードが簡易な key/value 表として表示できる平坦なオブジェクトか判定する。 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** セル 1 個ぶんの値をテキスト化する。 */
function cellToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return rawToText(value);
}

export function VisualizationFallback({ raw, reason }: VisualizationFallbackProps) {
  const note = REASON_LABELS[reason];
  const entries = isPlainObject(raw) ? Object.entries(raw) : null;

  return (
    <figure
      role="group"
      aria-label={`可視化フォールバック: ${note}`}
      style={{
        margin: 0,
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.5rem",
        backgroundColor: "var(--color-surface, #ffffff)",
        overflow: "hidden",
      }}
    >
      {/* 未対応 / 検証失敗を示す注記（Requirement 1.4, 1.5） */}
      <div
        role="note"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: "0.5rem 0.75rem",
          fontSize: "0.8rem",
          fontWeight: 600,
          color: "#92400e",
          backgroundColor: "#fef3c7",
          borderBottom: "1px solid var(--color-border, #e5e7eb)",
        }}
      >
        <span aria-hidden="true">⚠️</span>
        <span>{note}</span>
      </div>

      {/* 生ペイロードのテキスト / 簡易表表示 */}
      {entries && entries.length > 0 ? (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.85rem",
            color: "var(--color-text, #1a1a2e)",
          }}
        >
          <caption
            style={{
              textAlign: "left",
              padding: "0.5rem 0.75rem 0.25rem",
              fontSize: "0.75rem",
              color: "var(--color-text-secondary, #6b7280)",
            }}
          >
            可視化ペイロードの内容
          </caption>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <th
                  scope="row"
                  style={{
                    textAlign: "left",
                    verticalAlign: "top",
                    padding: "0.375rem 0.75rem",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    borderTop: "1px solid var(--color-border, #f1f5f9)",
                    color: "var(--color-text-secondary, #374151)",
                  }}
                >
                  {key}
                </th>
                <td
                  style={{
                    padding: "0.375rem 0.75rem",
                    borderTop: "1px solid var(--color-border, #f1f5f9)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {cellToText(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: "0.75rem",
            fontSize: "0.8rem",
            lineHeight: 1.5,
            color: "var(--color-text, #1a1a2e)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowX: "auto",
          }}
        >
          {rawToText(raw)}
        </pre>
      )}
    </figure>
  );
}

export default VisualizationFallback;
