import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  hexToRgb,
  meetsContrast,
  relativeLuminance,
  WCAG_CONTRAST_LARGE_TEXT,
  WCAG_CONTRAST_NORMAL_TEXT,
} from "./contrast";

/**
 * Task 8.3 — コントラスト比計算関数と使用トークンペアの列挙検証（Req 7.2）
 *
 * 下の LIGHT / DARK トークン値は `src/app/globals.css` の `:root` および
 * `@media (prefers-color-scheme: dark)` に定義された Design_Tokens を鏡写しにした
 * ものである（single source は globals.css）。globals.css を変更した場合はここも
 * 更新すること。チャット画面・セッション履歴サイドバー・Feedback_Dashboard が
 * 共有する実使用ペアが WCAG AA 閾値（通常テキスト 4.5:1 / 大テキスト・境界 3:1）を
 * 満たすことを列挙検証する。
 */

// --- globals.css :root（ライトモード）の鏡写し ---
const LIGHT = {
  text: "#1a1a2e",
  textSecondary: "#4b5563",
  textMuted: "#6b7280",
  bg: "#f4f6f9",
  surface: "#ffffff",
  surfaceAlt: "#f8fafc",
  surfaceMuted: "#f3f4f6",
  primary: "#0073bb",
  primaryHover: "#005a94",
  good: "#15803d",
  goodSurface: "#dcfce7",
  bad: "#b91c1c",
  badSurface: "#fee2e2",
  focus: "#2563eb",
} as const;

// --- globals.css @media dark の鏡写し ---
const DARK = {
  text: "#e8ecf5",
  textSecondary: "#aeb7c7",
  textMuted: "#8b95a7",
  bg: "#0f141f",
  surface: "#171d2b",
  surfaceAlt: "#1d2432",
  surfaceMuted: "#1d2432",
  primary: "#4da6e0",
  primaryHover: "#7abfea",
  good: "#46c485",
  goodSurface: "#143026",
  bad: "#f0776a",
  badSurface: "#33201d",
  focus: "#7abfea",
} as const;

interface Pair {
  name: string;
  fg: string;
  bg: string;
}

/** 通常サイズテキストのペア（対背景 4.5:1 以上, Req 7.2 前段） */
function normalTextPairs(t: typeof LIGHT | typeof DARK): Pair[] {
  return [
    // 本文テキスト
    { name: "text on surface", fg: t.text, bg: t.surface },
    { name: "text on bg", fg: t.text, bg: t.bg },
    { name: "text on surfaceAlt", fg: t.text, bg: t.surfaceAlt },
    { name: "text on surfaceMuted", fg: t.text, bg: t.surfaceMuted },
    // 二次テキスト
    { name: "textSecondary on surface", fg: t.textSecondary, bg: t.surface },
    { name: "textSecondary on bg", fg: t.textSecondary, bg: t.bg },
    { name: "textSecondary on surfaceAlt", fg: t.textSecondary, bg: t.surfaceAlt },
    // ミュートテキスト（タイムスタンプ等）はサーフェス上に配置される
    { name: "textMuted on surface", fg: t.textMuted, bg: t.surface },
    { name: "textMuted on surfaceAlt", fg: t.textMuted, bg: t.surfaceAlt },
    // リンク / プライマリテキスト
    { name: "primary on surface", fg: t.primary, bg: t.surface },
    { name: "primary on bg", fg: t.primary, bg: t.bg },
    // Good / Bad フィードバックのテキスト
    { name: "good on surface", fg: t.good, bg: t.surface },
    { name: "good on goodSurface", fg: t.good, bg: t.goodSurface },
    { name: "bad on surface", fg: t.bad, bg: t.surface },
    { name: "bad on badSurface", fg: t.bad, bg: t.badSurface },
  ];
}

/**
 * 大テキスト / インタラクティブ UI 境界のペア（対背景 3:1 以上, Req 7.2 後段）。
 * キーボードフォーカスリング（Req 7.3）とプライマリコンポーネント境界を対象とする。
 * 装飾的な区切り線（--color-border 等）は情報伝達に必須でないため WCAG 1.4.11 の
 * 対象外であり、ここでは検証しない。
 */
function boundaryPairs(t: typeof LIGHT | typeof DARK): Pair[] {
  return [
    { name: "focus ring on surface", fg: t.focus, bg: t.surface },
    { name: "focus ring on bg", fg: t.focus, bg: t.bg },
    { name: "primary boundary on surface", fg: t.primary, bg: t.surface },
    { name: "primary boundary on bg", fg: t.primary, bg: t.bg },
  ];
}

describe("contrastRatio — WCAG 計算関数の基本性質", () => {
  it("黒と白のコントラスト比は最大値 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("同一色のコントラスト比は 1", () => {
    expect(contrastRatio("#0073bb", "#0073bb")).toBeCloseTo(1, 5);
  });

  it("順序を入れ替えてもコントラスト比は同じ（対称）", () => {
    const a = contrastRatio("#1a1a2e", "#ffffff");
    const b = contrastRatio("#ffffff", "#1a1a2e");
    expect(a).toBeCloseTo(b, 10);
  });

  it("既知ペア（slate-600 #4b5563 on white）は約 7.56:1", () => {
    expect(contrastRatio("#4b5563", "#ffffff")).toBeCloseTo(7.56, 2);
  });

  it("Rgb オブジェクトと 16 進文字列で同じ結果になる", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(
      contrastRatio("#000000", "#ffffff"),
      10,
    );
  });
});

describe("relativeLuminance — 相対輝度", () => {
  it("白は 1、黒は 0", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  });
});

describe("hexToRgb — 16 進カラーのパース", () => {
  it("6 桁 16 進をパースする", () => {
    expect(hexToRgb("#0073bb")).toEqual({ r: 0, g: 115, b: 187 });
  });

  it("3 桁ショートハンドを展開する", () => {
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("先頭 # の有無どちらも受理する", () => {
    expect(hexToRgb("1a1a2e")).toEqual(hexToRgb("#1a1a2e"));
  });

  it("不正な形式は例外を投げる", () => {
    expect(() => hexToRgb("#12")).toThrow();
    expect(() => hexToRgb("#zzzzzz")).toThrow();
    expect(() => hexToRgb("not-a-color")).toThrow();
  });
});

describe("meetsContrast — 閾値判定", () => {
  it("閾値以上なら true", () => {
    expect(meetsContrast("#1a1a2e", "#ffffff", WCAG_CONTRAST_NORMAL_TEXT)).toBe(true);
  });

  it("閾値未満なら false", () => {
    // 装飾的境界色 --color-border(#e2e8f0) on white は 3:1 未満
    expect(meetsContrast("#e2e8f0", "#ffffff", WCAG_CONTRAST_LARGE_TEXT)).toBe(false);
  });
});

describe("Design_Tokens コントラスト列挙検証（Req 7.2）", () => {
  describe("ライトモード: 通常テキスト >= 4.5:1", () => {
    it.each(normalTextPairs(LIGHT))("$name", ({ fg, bg }) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_CONTRAST_NORMAL_TEXT);
    });
  });

  describe("ライトモード: 大テキスト・UI 境界 >= 3:1", () => {
    it.each(boundaryPairs(LIGHT))("$name", ({ fg, bg }) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_CONTRAST_LARGE_TEXT);
    });
  });

  describe("ダークモード: 通常テキスト >= 4.5:1", () => {
    it.each(normalTextPairs(DARK))("$name", ({ fg, bg }) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_CONTRAST_NORMAL_TEXT);
    });
  });

  describe("ダークモード: 大テキスト・UI 境界 >= 3:1", () => {
    it.each(boundaryPairs(DARK))("$name", ({ fg, bg }) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_CONTRAST_LARGE_TEXT);
    });
  });
});
