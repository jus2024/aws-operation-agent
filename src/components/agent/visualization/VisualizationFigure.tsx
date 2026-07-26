"use client";

import type { ReactNode } from "react";
import {
  toAccessibleTable,
  type NormalizedVisualizationPayload,
} from "@/src/lib/agent/visualization/schema";

/**
 * VisualizationFigure — 全 Visualization が共有するアクセシブルな図の枠
 *
 * すべての可視化を `<figure>` でラップし、以下のアクセシブル代替を付与する
 * （Requirement 1.7, 1.8）:
 *   - `aria-label`: タイトルを支援技術へ伝える
 *   - `<figcaption>`: タイトルを視覚的にも表示する
 *   - 視覚的に隠したデータ表: `toAccessibleTable` が返す全データ値を
 *     `<table>` として支援技術へ提供する（チャート型の下地データを表形式で
 *     取得可能にする — Requirement 1.8）
 *
 * データ表そのものを主コンテンツとして可視表示する `DataTableView` は
 * `renderAccessibleTable={false}` を指定し、重複した隠し表を出さない
 * （視覚表とアクセシブル表を兼ねる）。
 *
 * Requirements: 1.7, 1.8
 */

/** 視覚的に隠すが支援技術には露出するスタイル（sr-only 相当）。 */
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface VisualizationFigureProps {
  /** 正規化済みペイロード（タイトル + 全データ値の抽出元） */
  payload: NormalizedVisualizationPayload;
  /** 図の視覚コンテンツ（チャート / 表本体） */
  children: ReactNode;
  /**
   * アクセシブルなデータ表（視覚的に隠した `<table>`）を描画するか。
   * 既定 true。可視の表を自ら描画する `DataTableView` は false を渡す。
   */
  renderAccessibleTable?: boolean;
}

/** アクセシブルなデータ表を `<table>` として描画する（可視 / 不可視共通）。 */
export function AccessibleDataTable({
  payload,
  hidden,
}: {
  payload: NormalizedVisualizationPayload;
  hidden?: boolean;
}) {
  const table = toAccessibleTable(payload);

  return (
    <table
      style={
        hidden
          ? visuallyHidden
          : {
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85rem",
              color: "var(--color-text, #1a1a2e)",
            }
      }
    >
      {/* figure の aria-label / figcaption がタイトルを担うため、表 caption は
          支援技術向けに視覚的に隠して重複表示を避ける */}
      <caption style={visuallyHidden}>{table.caption}</caption>
      <thead>
        <tr>
          {table.columns.map((col, i) => (
            <th
              key={`${col}-${i}`}
              scope="col"
              style={
                hidden
                  ? undefined
                  : {
                      textAlign: "left",
                      padding: "0.375rem 0.625rem",
                      borderBottom: "2px solid var(--color-border, #e5e7eb)",
                      fontWeight: 600,
                    }
              }
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => (
              <td
                key={c}
                style={
                  hidden
                    ? undefined
                    : {
                        padding: "0.375rem 0.625rem",
                        borderBottom: "1px solid var(--color-border, #f0f0f3)",
                      }
                }
              >
                {String(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function VisualizationFigure({
  payload,
  children,
  renderAccessibleTable = true,
}: VisualizationFigureProps) {
  return (
    <figure
      role="figure"
      aria-label={payload.title}
      style={{
        margin: "0.5rem 0",
        padding: "0.75rem 1rem",
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.5rem",
        backgroundColor: "var(--color-surface, #ffffff)",
      }}
    >
      {children}
      <figcaption
        style={{
          marginTop: "0.5rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "var(--color-text, #1a1a2e)",
        }}
      >
        {payload.title}
      </figcaption>
      {renderAccessibleTable && <AccessibleDataTable payload={payload} hidden />}
    </figure>
  );
}

export default VisualizationFigure;
