/**
 * Visualization.test.tsx — Generative UI ディスパッチャのユニットテスト
 *
 * Task 5.4（ui-ux-enhancements）: 特定例・エッジのみを検証する。網羅的な
 * 入力空間の検証は `schema.pbt.test.ts` のプロパティテスト（Property 1〜3）に
 * 委譲する。ここでは以下の代表的振る舞いを確認する:
 *   - 4 可視化タイプ（bar / line / pie / table）が各対応ビューへ描画される
 *   - 非対応タイプは `VisualizationFallback`（"未対応" 注記）へフォールバック
 *   - 検証失敗（invalid_schema）はフォールバックへ分類され、例外を投げずに
 *     メッセージ残部の描画を継続できる
 *
 * 既存のコンポーネント/フックテスト慣習（`react-test-renderer` + `act`）に準拠する。
 * 対象コンポーネントは CopilotKit フックを用いない純粋な表示コンポーネントのため、
 * プロバイダー無しで直接レンダリングできる。
 *
 * Requirements: 1.2, 1.4, 1.5
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { Visualization } from "./Visualization";
import { BarChartView } from "./BarChartView";
import { LineChartView } from "./LineChartView";
import { PieChartView } from "./PieChartView";
import { DataTableView } from "./DataTableView";
import { VisualizationFallback } from "./VisualizationFallback";

// --- ヘルパー ---

/** 純粋な同期レンダリングを act でラップして renderer を得る。 */
function renderSync(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

/** react-test-renderer の JSON ツリーから全テキストノードを連結する。 */
function allText(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(allText).join("");
  const json = node as { children?: unknown };
  return allText(json.children);
}

/** レンダリング結果の全テキストを取得する。 */
function textContent(renderer: ReactTestRenderer): string {
  return allText(renderer.toJSON());
}

// ============================================================================
// 4 可視化タイプの描画（Requirement 1.2）
// ============================================================================

describe("Visualization ディスパッチャ: 4 可視化タイプの描画", () => {
  it("bar タイプは BarChartView へ描画し、タイトルとデータ値をアクセシブルに提示する", () => {
    const payload = {
      type: "bar",
      title: "月次売上",
      series: [
        { label: "1月", value: 120 },
        { label: "2月", value: 340 },
      ],
    };

    const renderer = renderSync(<Visualization payload={payload} />);

    expect(renderer.root.findAllByType(BarChartView)).toHaveLength(1);
    expect(renderer.root.findAllByType(VisualizationFallback)).toHaveLength(0);

    // <figure aria-label> にタイトルを載せてアクセシブルにしている（Req 1.7）。
    const figure = renderer.root.findByProps({ role: "figure" });
    expect(figure.props["aria-label"]).toBe("月次売上");

    // 下地データ値がテキストとして取得可能（Req 1.8）。
    const text = textContent(renderer);
    expect(text).toContain("1月");
    expect(text).toContain("120");
    expect(text).toContain("2月");
    expect(text).toContain("340");
  });

  it("line タイプは LineChartView へ描画する", () => {
    const payload = {
      type: "line",
      title: "アクセス推移",
      series: [
        {
          name: "PV",
          points: [
            { x: "月", y: 10 },
            { x: "火", y: 25 },
          ],
        },
      ],
    };

    const renderer = renderSync(<Visualization payload={payload} />);

    expect(renderer.root.findAllByType(LineChartView)).toHaveLength(1);
    expect(renderer.root.findAllByType(VisualizationFallback)).toHaveLength(0);
    expect(renderer.root.findByProps({ role: "figure" }).props["aria-label"]).toBe(
      "アクセス推移",
    );
    const text = textContent(renderer);
    expect(text).toContain("PV");
    expect(text).toContain("25");
  });

  it("pie タイプは PieChartView へ描画する", () => {
    const payload = {
      type: "pie",
      title: "構成比",
      series: [
        { label: "A", value: 60 },
        { label: "B", value: 40 },
      ],
    };

    const renderer = renderSync(<Visualization payload={payload} />);

    expect(renderer.root.findAllByType(PieChartView)).toHaveLength(1);
    expect(renderer.root.findAllByType(VisualizationFallback)).toHaveLength(0);
    const text = textContent(renderer);
    expect(text).toContain("A");
    expect(text).toContain("60");
  });

  it("table タイプは DataTableView へ描画し、全セル値をテキストで提示する", () => {
    const payload = {
      type: "table",
      title: "一覧",
      series: [],
      columns: ["名前", "件数"],
      rows: [
        ["Alpha", 3],
        ["Beta", 7],
      ],
    };

    const renderer = renderSync(<Visualization payload={payload} />);

    expect(renderer.root.findAllByType(DataTableView)).toHaveLength(1);
    expect(renderer.root.findAllByType(VisualizationFallback)).toHaveLength(0);
    const text = textContent(renderer);
    expect(text).toContain("名前");
    expect(text).toContain("件数");
    expect(text).toContain("Alpha");
    expect(text).toContain("7");
  });
});

// ============================================================================
// 非対応タイプのフォールバック（Requirement 1.4）
// ============================================================================

describe("Visualization ディスパッチャ: 非対応タイプのフォールバック", () => {
  it("対応 4 種でないタイプは VisualizationFallback（unsupported_type）へ描画し、未対応の注記を表示する", () => {
    const payload = {
      type: "scatter",
      title: "散布図",
      series: [{ label: "x", value: 1 }],
    };

    const renderer = renderSync(<Visualization payload={payload} />);

    const fallbacks = renderer.root.findAllByType(VisualizationFallback);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].props.reason).toBe("unsupported_type");

    // どのチャート/表ビューも描画されない。
    expect(renderer.root.findAllByType(BarChartView)).toHaveLength(0);
    expect(renderer.root.findAllByType(LineChartView)).toHaveLength(0);
    expect(renderer.root.findAllByType(PieChartView)).toHaveLength(0);
    expect(renderer.root.findAllByType(DataTableView)).toHaveLength(0);

    // 「未対応」を示す注記が表示される（Req 1.4）。
    expect(textContent(renderer)).toContain("未対応");
  });
});

// ============================================================================
// 検証失敗時のフォールバックと描画継続（Requirement 1.5）
// ============================================================================

describe("Visualization ディスパッチャ: 検証失敗時のフォールバックと描画継続", () => {
  it("スキーマ非適合のペイロードは VisualizationFallback（invalid_schema）へ描画し、検証失敗の注記を表示する", () => {
    // type は対応（bar）だが series の value が数値でない → invalid_schema。
    const payload = {
      type: "bar",
      title: "壊れたデータ",
      series: [{ label: "a", value: "not-a-number" }],
    };

    const renderer = renderSync(<Visualization payload={payload} />);

    const fallbacks = renderer.root.findAllByType(VisualizationFallback);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].props.reason).toBe("invalid_schema");
    expect(textContent(renderer)).toContain("検証に失敗");
  });

  it("null / プリミティブ / 配列など不正な入力でも例外を投げずフォールバックへ分類する", () => {
    for (const bad of [null, undefined, 42, "text", [], { type: 123 }]) {
      const renderer = renderSync(<Visualization payload={bad} />);
      expect(renderer.root.findAllByType(VisualizationFallback)).toHaveLength(1);
    }
  });

  it("検証失敗の可視化が混在しても、メッセージ残部の描画を中断させない", () => {
    const invalid = { type: "bar", title: "x", series: [{ label: "a", value: null }] };

    // 可視化ブロックの前後にメッセージ本文が並ぶ状況を模す。
    const renderer = renderSync(
      <div>
        <span>本文の前半テキスト</span>
        <Visualization payload={invalid} />
        <span>本文の後半テキスト</span>
      </div>,
    );

    // フォールバックが描画されつつ、前後のテキストも失われない（Req 1.5）。
    expect(renderer.root.findAllByType(VisualizationFallback)).toHaveLength(1);
    const text = textContent(renderer);
    expect(text).toContain("本文の前半テキスト");
    expect(text).toContain("本文の後半テキスト");
  });
});
