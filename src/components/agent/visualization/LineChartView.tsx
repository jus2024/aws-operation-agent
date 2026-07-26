"use client";

import type {
  LineSeries,
  NormalizedVisualizationPayload,
} from "@/src/lib/agent/visualization/schema";
import { VisualizationFigure } from "./VisualizationFigure";

/**
 * LineChartView — 折れ線グラフの可視化（Requirement 1.2）
 *
 * `LineSeries[]`（name + points{x,y}）を SVG のポリラインとして描画する。
 * x は数値ならその値、文字列ならその系列内のインデックスを座標に用い、
 * y はグローバルな min/max で正規化する。点が 1 個以下・全点同値・空系列
 * などのエッジでも例外を投げないよう座標を安全側に丸める。視覚部分は
 * `aria-hidden` とし、下地データは視覚的に隠したデータ表で支援技術へ提供する
 * （Requirement 1.7, 1.8）。
 *
 * Requirements: 1.1, 1.2, 1.7, 1.8
 */

export interface LineChartViewProps {
  payload: NormalizedVisualizationPayload;
}

const LINE_COLORS = [
  "#0073bb",
  "#ff9900",
  "#1e8900",
  "#d13212",
  "#7d3ac1",
  "#00a1c9",
];

const W = 100;
const H = 50;

export function LineChartView({ payload }: LineChartViewProps) {
  const series = payload.series as LineSeries[];

  // x 座標（数値なら値、文字列ならインデックス）と y をすべて収集
  const resolved = series.map((s) =>
    s.points.map((pt, idx) => ({
      x: typeof pt.x === "number" ? pt.x : idx,
      y: pt.y,
    })),
  );

  const allX = resolved.flat().map((p) => p.x);
  const allY = resolved.flat().map((p) => p.y);

  const xMin = allX.length ? Math.min(...allX) : 0;
  const xMax = allX.length ? Math.max(...allX) : 0;
  const yMin = allY.length ? Math.min(...allY) : 0;
  const yMax = allY.length ? Math.max(...allY) : 0;

  const mapX = (x: number) => (xMax === xMin ? W / 2 : ((x - xMin) / (xMax - xMin)) * W);
  const mapY = (y: number) =>
    yMax === yMin ? H / 2 : H - ((y - yMin) / (yMax - yMin)) * H;

  return (
    <VisualizationFigure payload={payload}>
      <div
        aria-hidden="true"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{
            width: "100%",
            height: "8rem",
            border: "1px solid var(--color-border, #e5e7eb)",
            borderRadius: "0.375rem",
            backgroundColor: "var(--color-surface, #ffffff)",
          }}
        >
          {resolved.map((pts, i) => {
            const color = LINE_COLORS[i % LINE_COLORS.length];
            if (pts.length === 0) return null;
            if (pts.length === 1) {
              return (
                <circle
                  key={i}
                  cx={mapX(pts[0].x)}
                  cy={mapY(pts[0].y)}
                  r={1.2}
                  fill={color}
                />
              );
            }
            const points = pts.map((p) => `${mapX(p.x)},${mapY(p.y)}`).join(" ");
            return (
              <polyline
                key={i}
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={0.8}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {series.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
            }}
          >
            {series.map((s, i) => (
              <li
                key={`${s.name}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.375rem",
                  fontSize: "0.75rem",
                  color: "var(--color-text-secondary, #374151)",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: "1rem",
                    height: "0.2rem",
                    backgroundColor: LINE_COLORS[i % LINE_COLORS.length],
                  }}
                />
                {s.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </VisualizationFigure>
  );
}

export default LineChartView;
