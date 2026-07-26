"use client";

import {
  parseVisualization,
  type VisualizationType,
} from "@/src/lib/agent/visualization/schema";
import { BarChartView } from "./BarChartView";
import { LineChartView } from "./LineChartView";
import { PieChartView } from "./PieChartView";
import { DataTableView } from "./DataTableView";
import { VisualizationFallback } from "./VisualizationFallback";

/**
 * Visualization — Generative UI のディスパッチャ（Requirement 1.1, 1.2）
 *
 * Agent が AG-UI で送出した生の可視化ペイロードを `parseVisualization` に通し、
 * 検証・正規化した上で型（bar/line/pie/table）に応じた子コンポーネントへ
 * ディスパッチする。純粋ロジック（`schema.ts`）が正規化まで担うため、本
 * コンポーネントはランタイムロジックを持たず描画振り分けに徹する（Req 8.4）。
 *
 * 検証失敗（`invalid_schema`）・非対応型（`unsupported_type`）の場合は、
 * `VisualizationFallback`（生ペイロードのテキスト/簡易表 + 理由の注記）を描画する。
 * これにより可視化として描画できなくても情報を失わず、アシスタントメッセージの
 * 残りの描画を中断させない（Req 1.4, 1.5）。
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 1.7, 1.8
 */

export interface VisualizationProps {
  /** Agent から届いた生ペイロード（検証前・型不明） */
  payload: unknown;
}

const VIEWS: Record<
  VisualizationType,
  React.ComponentType<{ payload: import("@/src/lib/agent/visualization/schema").NormalizedVisualizationPayload }>
> = {
  bar: BarChartView,
  line: LineChartView,
  pie: PieChartView,
  table: DataTableView,
};

export function Visualization({ payload }: VisualizationProps) {
  const result = parseVisualization(payload);

  if (!result.ok) {
    // 検証失敗・非対応型: 生ペイロードをテキスト/簡易表で提示し、理由を注記する。
    return <VisualizationFallback raw={result.raw} reason={result.reason} />;
  }

  const View = VIEWS[result.payload.type];
  return <View payload={result.payload} />;
}

export default Visualization;
