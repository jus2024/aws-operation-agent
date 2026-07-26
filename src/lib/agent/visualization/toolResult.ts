/**
 * toolResult — AG-UI で届いた可視化ペイロードの取り出し（純粋ロジック）
 *
 * Agent（`agents/app/AWS_MCP_Agent/visualization/`）は可視化を次の 2 経路で送出する。
 *   - `emit_visualization` ツールの結果（`TOOL_CALL_RESULT`）。content に
 *     `{ json: { name: "visualization", value: <正規化済みペイロード> } }` と
 *     `{ text: <JSON 文字列> }` を載せる。
 *   - AG-UI `CustomEvent`（`name = "visualization"`、`value = <正規化済みペイロード>`）。
 *
 * フロントは CopilotKit v2 の `useRenderTool`（`emit_visualization` 名スコープ）で
 * ツール結果を受け取るが、AG-UI / ag-ui-strands 上でツール結果文字列がどの
 * エンベロープ形状で届くか（生ペイロード直か、`{name,value}` ラッパーか、
 * content ブロック配列か）は結合フェーズで確定する実装詳細である
 * （design.md「スコープ外の確定事項」）。ローカルではフロント↔Agent を結合
 * 検証できない（SigV4 + コンピューティングロールが必要）ため、本モジュールは
 * 想定されるエンベロープ形状を横断して可視化ペイロードを頑健に取り出す。
 *
 * 本モジュールは `schema.ts` と同じくインフラ非依存の純粋関数であり、React /
 * CopilotKit / Amplify に依存しない（`amplify-frontend` ルール: UI とロジックの分離）。
 * 取り出した候補は最終的に `parseVisualization()` が検証・正規化する。
 *
 * Requirements: 1.1, 1.5, 8.2, 8.3
 */

import { parseVisualization } from "./schema";

/**
 * Agent が可視化を送出するツール名。Agent 側 `VISUALIZATION_TOOL_NAME`
 * （`agents/app/AWS_MCP_Agent/visualization/tool.py`）と一致させる。
 */
export const VISUALIZATION_TOOL_NAME = "emit_visualization";

/**
 * 可視化ペイロードを載せる AG-UI CustomEvent / エンベロープの `name`。
 * Agent 側 `VISUALIZATION_EVENT_NAME`
 * （`agents/app/AWS_MCP_Agent/visualization/schema.py`）と一致させる。
 */
export const VISUALIZATION_EVENT_NAME = "visualization";

/** 探索で潜り込むエンベロープキー（Strands ToolResult / AG-UI の一般的な形）。 */
const CONTAINER_KEYS = [
  "value",
  "json",
  "content",
  "result",
  "output",
  "data",
  "text",
] as const;

/** 探索の暴走を防ぐノード訪問数の上限（深くネストした異常入力への保険）。 */
const MAX_NODES = 1000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** 文字列なら JSON.parse を試み、失敗時は undefined を返す（例外を投げない）。 */
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * ツール結果 / カスタムイベント値から可視化ペイロード候補を取り出す（全域関数）。
 *
 * 幅優先でノードを走査し、`parseVisualization` が受理する最初のノードを返す。
 * 文字列ノードは JSON として解釈を試みる。`{ name: "visualization", value }`
 * ラッパーや content ブロック配列、`{ json | content | text | ... }` などの
 * ネストしたエンベロープを横断して探索する。
 *
 * 有効な可視化ペイロードが見つからない場合は、最初に解釈できたオブジェクト
 * （なければ元の入力）を返す。呼び出し側は戻り値を `parseVisualization()` に
 * 通すため、無効な候補はテキストフォールバックへ分類される（Req 1.5）。
 *
 * @param raw ツール結果文字列 / カスタムイベント値 / 既にパース済みの値。
 * @returns `parseVisualization()` に渡すべきペイロード候補。
 */
export function extractVisualizationPayload(raw: unknown): unknown {
  const seen = new Set<object>();
  const queue: unknown[] = [raw];
  let firstObject: unknown;
  let hasFirstObject = false;
  let visited = 0;

  while (queue.length > 0 && visited < MAX_NODES) {
    let node = queue.shift();
    visited += 1;

    if (typeof node === "string") {
      const parsed = tryParseJson(node);
      if (parsed === undefined) continue;
      node = parsed;
    }

    if (!isRecord(node) && !Array.isArray(node)) continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);

    if (!hasFirstObject) {
      firstObject = node;
      hasFirstObject = true;
    }

    // 直接この階層が有効なペイロードなら即採用。
    if (parseVisualization(node).ok) return node;

    if (Array.isArray(node)) {
      for (const el of node) queue.push(el);
      continue;
    }

    // `{ name: "visualization", value }` ラッパーは value を優先的に辿る。
    if (node.name === VISUALIZATION_EVENT_NAME && "value" in node) {
      queue.unshift(node.value);
      continue;
    }

    for (const key of CONTAINER_KEYS) {
      if (key in node) queue.push(node[key]);
    }
  }

  return hasFirstObject ? firstObject : raw;
}
