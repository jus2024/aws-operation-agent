"use client";

import type { NormalizedVisualizationPayload } from "@/src/lib/agent/visualization/schema";
import { AccessibleDataTable, VisualizationFigure } from "./VisualizationFigure";

/**
 * DataTableView — 表データの可視化（Requirement 1.2）
 *
 * `columns` / `rows` を可視の `<table>` として描画する。この表は視覚表と
 * アクセシブルなデータ表を兼ねるため、`VisualizationFigure` 側の隠しデータ表は
 * 抑止する（`renderAccessibleTable={false}`）。表自体が全データ値を
 * テキストで提供する（Requirement 1.7, 1.8）。
 *
 * Requirements: 1.1, 1.2, 1.7, 1.8
 */

export interface DataTableViewProps {
  payload: NormalizedVisualizationPayload;
}

export function DataTableView({ payload }: DataTableViewProps) {
  return (
    <VisualizationFigure payload={payload} renderAccessibleTable={false}>
      <div style={{ overflowX: "auto" }}>
        <AccessibleDataTable payload={payload} />
      </div>
    </VisualizationFigure>
  );
}

export default DataTableView;
