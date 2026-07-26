/**
 * WCAG 2.x コントラスト比計算（純粋ロジック, Req 7.2）
 *
 * 通常テキストは対背景 4.5:1 以上、大テキスト・UI コンポーネント境界は
 * 3:1 以上を満たすことを検証するための純粋関数群。UI/インフラに依存せず、
 * vitest でユニットテストできる（`amplify-frontend` ルール: ロジック分離）。
 *
 * 参照: WCAG 2.1 相対輝度・コントラスト比の定義
 *   L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 *   （R,G,B は sRGB からガンマ補正解除した線形値）
 *   contrast = (Llighter + 0.05) / (Ldarker + 0.05)
 */

export interface Rgb {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

/** WCAG のコントラスト閾値 */
export const WCAG_CONTRAST_NORMAL_TEXT = 4.5; // 通常サイズテキスト（AA）
export const WCAG_CONTRAST_LARGE_TEXT = 3; // 大テキスト / UI コンポーネント境界（AA）

/**
 * `#rgb` / `#rrggbb` 形式の 16 進カラーを RGB(0-255) へ変換する（全域関数）。
 * 不正な形式なら例外を投げる（開発時に誤ったトークンを検出するため）。
 */
export function hexToRgb(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, "");
  let full: string;
  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    full = normalized
      .split("")
      .map((c) => c + c)
      .join("");
  } else if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    full = normalized;
  } else {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** 単一 sRGB チャネル(0-1)をガンマ補正解除して線形値へ変換する */
function linearizeChannel(channel0to1: number): number {
  return channel0to1 <= 0.03928
    ? channel0to1 / 12.92
    : Math.pow((channel0to1 + 0.055) / 1.055, 2.4);
}

/** 相対輝度 L を返す（0=黒, 1=白）。WCAG 2.x 定義 */
export function relativeLuminance(color: Rgb | string): number {
  const rgb = typeof color === "string" ? hexToRgb(color) : color;
  const r = linearizeChannel(rgb.r / 255);
  const g = linearizeChannel(rgb.g / 255);
  const b = linearizeChannel(rgb.b / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 2 色間のコントラスト比を返す（純粋・全域）。
 * 戻り値は 1（同色）〜 21（黒対白）の範囲。順序に依存しない。
 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** foreground/background が指定閾値以上のコントラストを満たすか（純粋述語） */
export function meetsContrast(
  foreground: Rgb | string,
  background: Rgb | string,
  threshold: number,
): boolean {
  return contrastRatio(foreground, background) >= threshold;
}
