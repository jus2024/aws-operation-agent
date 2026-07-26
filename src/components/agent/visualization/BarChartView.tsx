"use client";

import type {
  CategoryDatum,
  NormalizedVisualizationPayload,
} from "@/src/lib/agent/visualization/schema";
import { VisualizationFigure } from "./VisualizationFigure";

/**
 * BarChartView — 棒グラフの可視化（Requirement 1.2）
 *
 * `CategoryDatum[]`（label + value）を横棒として描画する。チャート依存の
 * 外部ライブラリは用いず、CSS 幅比率のみで軽量に表現する（チャートライブラリ
 * 選定は設計上 Out of Scope）。視覚バーは `aria-hidden` とし、下地データは
 * `VisualizationFigure` の視覚的に隠したデータ表で支援技術へ提供する
 * （Requirement 1.7, 1.8）。
 *
 * Requirements: 1.1, 1.2, 1.7, 1.8
 */

export interface BarChartViewProps {
  payload: NormalizedVisualizationPayload;
}

const BAR_COLOR = "var(--color-primary, #0073bb)";

export function BarChartView({ payload }: BarChartViewProps) {
  const series = payload.series as CategoryDatum[];
  const maxAbs = series.reduce((m, d) => Math.max(m, Math.abs(d.value)), 0);

  return (
    <VisualizationFigure payload={payload}>
      <div
        aria-hidden="true"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.375rem",
        }}
      >
        {series.map((d, i) => {
          const widthPct = maxAbs === 0 ? 0 : (Math.abs(d.value) / maxAbs) * 100;
          return (
            <div
              key={`${d.label}-${i}`}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <span
                style={{
                  flex: "0 0 8rem",
                  fontSize: "0.8rem",
                  color: "var(--color-text-secondary, #374151)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={d.label}
              >
                {d.label}
              </span>
              <span
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    height: "0.9rem",
                    width: `${widthPct}%`,
                    minWidth: d.value !== 0 ? "2px" : 0,
                    backgroundColor: BAR_COLOR,
                    borderRadius: "0.2rem",
                  }}
                />
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--color-text-secondary, #6b7280)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.value}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </VisualizationFigure>
  );
}

export default BarChartView;
