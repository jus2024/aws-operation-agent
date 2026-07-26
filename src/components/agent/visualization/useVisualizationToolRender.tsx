"use client";

import { useRenderTool } from "@copilotkit/react-core/v2";
import {
  extractVisualizationPayload,
  VISUALIZATION_TOOL_NAME,
} from "@/src/lib/agent/visualization/toolResult";
import { Visualization } from "./Visualization";

/**
 * useVisualizationToolRender — Visualization を CopilotChat レンダリングへ配線
 *
 * Agent が `emit_visualization` ツール（`agents/app/AWS_MCP_Agent/visualization/`）
 * で送出した可視化ペイロードを、CopilotKit v2 の名前スコープ付きツールレンダラ
 * （`useRenderTool`）で受け取り、`Visualization` ディスパッチャへ渡して描画する。
 * `Visualization` は受信ペイロードを `parseVisualization()` に通して検証・正規化し、
 * 検証失敗・非対応型のときは `VisualizationFallback`（テキスト表現 + 理由）を描画する
 * （Req 1.1, 1.5）。
 *
 * このレンダラは当該ツール呼び出しブロックにのみスコープされるため、可視化の
 * 検証が失敗しても、アシスタントメッセージの残り（テキスト・他のブロック）は
 * CopilotChat の通常描画でそのまま継続する（Req 1.5）。他のツールは CopilotKit の
 * 既定ツールカードで描画され、本レンダラは影響しない。
 *
 * import は `@copilotkit/react-core/v2` のみ（Req 8.2）。ブラウザ →
 * `/api/copilotkit` → HttpAgent(SigV4) → AgentCore の接続構成は一切変更しない
 * （Req 8.3）。可視化データを生成するランタイムロジックはフロントに持たない
 * （Req 8.4）。本フックは `CopilotKit`（`CopilotProvider`）配下でのみ呼び出すこと。
 *
 * Requirements: 1.1, 1.5, 8.2, 8.3
 */

/**
 * `useRenderTool` の名前スコープ登録が要求する引数スキーマ（Standard Schema V1）。
 *
 * 可視化ペイロードの実検証は `Visualization` 内の `parseVisualization()` が担うため、
 * ここではツール引数を素通し（passthrough）する最小スキーマとする。zod 等の
 * スキーマライブラリへ依存しないよう Standard Schema 形状を直接構成する。
 */
const passthroughToolArgsSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "ui-ux-enhancements",
    validate: (
      value: unknown,
    ): { value: Record<string, unknown> } => ({
      value: (value ?? {}) as Record<string, unknown>,
    }),
  },
};

/** 送出中（結果未確定）に一時表示する軽量プレースホルダ。 */
function VisualizationPending() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        margin: "0.5rem 0",
        padding: "0.5rem 0.75rem",
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.375rem",
        fontSize: "0.8rem",
        color: "var(--color-text-secondary, #6b7280)",
        backgroundColor: "var(--color-surface-muted, #f3f4f6)",
      }}
    >
      可視化を生成中...
    </div>
  );
}

/**
 * `emit_visualization` ツール呼び出しの可視化レンダラを CopilotKit v2 に登録する。
 *
 * `CopilotKit`（`CopilotProvider`）配下のコンポーネントから呼び出すこと。
 */
export function useVisualizationToolRender(): void {
  useRenderTool(
    {
      name: VISUALIZATION_TOOL_NAME,
      parameters: passthroughToolArgsSchema,
      render: (props) => {
        // 完了時はツール結果（`result`）からペイロードを取り出す。ストリーミング
        // 途中は引数側（`parameters.payload`）があれば先行描画する。`result` /
        // `parameters` はいずれのステータスでも参照可能（未確定時は undefined）。
        const params = props.parameters as { payload?: unknown } | undefined;
        const source = props.result ?? params?.payload;

        if (source === undefined || source === null) {
          return <VisualizationPending />;
        }

        return <Visualization payload={extractVisualizationPayload(source)} />;
      },
    },
    [],
  );
}
