import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// tsconfig の `paths` (`@/*` -> `./*`) を vitest でも解決できるようにする。
// 既存テストは相対 import のため影響なし（エイリアス追加は加算的な変更）。
const projectRoot = fileURLToPath(new URL(".", import.meta.url)).replace(
  /\/$/,
  "",
);

export default defineConfig({
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  // コンポーネントは Next.js と同じく自動 JSX ランタイムを前提に React を
  // 明示 import しない。vitest(esbuild) でも automatic ランタイムを使う。
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
  },
});
