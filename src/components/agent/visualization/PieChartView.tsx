"use client";

import type {
  CategoryDatum,
  NormalizedVisualizationPayload,
} from "@/src/lib/agent/visualization/schema";
import { VisualizationFigure } from "./VisualizationFigure";

/**
 * PieChartView — 円グラフの可視化（Requirement 1.2）
 *
 * `CategoryDatum[]`（label + value）を CSS `conic-gradient` の円と凡例
 * （ラベル + 値 + 構成比）で描画する。負値や合計 0 のエッジでも例外を
 * 投げないよう、合計は正値のみを対象に算出する。視覚部分は `aria-hidden`
 * とし、下地データは視覚的に隠したデータ表で支援技術へ提供する
 * （Requirement 1.7, 1.8）。
 *
 * Requirements: 1.1, 1.2, 1.7, 1.8
 */

export interface PieChartViewProps {
  payload: NormalizedVisualizationPayload;
}

const SLICE_COLORS = [
  "#0073bb",
  "#ff9900",
  "#1e8900",
  "#d13212",
  "#7d3ac1",
  "#00a1c9",
  "#eb5f07",
  "#545b64",
];

export function PieChartView({ payload }: PieChartViewProps) {
  const series = payload.series as CategoryDatum[];
  const positive = series.map((d) => Math.max(0, d.value));
  const total = positive.reduce((s, v) => s + v, 0);

  // conic-gradient のストップを構成する
  let acc = 0;
  const stops: string[] = [];
  series.forEach((_, i) => {
    const color = SLICE_COLORS[i % SLICE_COLORS.length];
    const start = total === 0 ? 0 : (acc / total) * 360;
    acc += positive[i];
    const end = total === 0 ? 0 : (acc / total) * 360;
    stops.push(`${color} ${start}deg ${end}deg`);
  });
  const gradient =
    total === 0
      ? "var(--color-surface-muted, #f3f4f6)"
      : `conic-gradient(${stops.join(", ")})`;

  return (
    <VisualizationFigure payload={payload}>
      <div
        aria-hidden="true"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: "7rem",
            height: "7rem",
            borderRadius: "50%",
            background: gradient,
            flexShrink: 0,
            border: "1px solid var(--color-border, #e5e7eb)",
          }}
        />
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {series.map((d, i) => {
            const pct = total === 0 ? 0 : (Math.max(0, d.value) / total) * 100;
            return (
              <li
                key={`${d.label}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  fontSize: "0.8rem",
                  color: "var(--color-text-secondary, #374151)",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: "0.7rem",
                    height: "0.7rem",
                    borderRadius: "0.15rem",
                    backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length],
                    flexShrink: 0,
                  }}
                />
                <span>
                  {d.label}: {d.value}（{pct.toFixed(1)}%）
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </VisualizationFigure>
  );
}

export default PieChartView;
