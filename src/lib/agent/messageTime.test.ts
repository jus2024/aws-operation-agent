/**
 * formatMessageTime のユニットテスト
 *
 * ローカルタイムゾーン依存を避けるため、Date から算出される期待値は
 * 同じ `new Date(epochMs)` の getHours/getMinutes から動的に組み立てて比較する
 * （CI/ローカルの TZ に関わらず安定させる）。ゼロ埋め・無効入力の分岐は
 * TZ 非依存なので固定の期待値で検証する。
 */

import { describe, it, expect } from "vitest";
import { formatMessageTime } from "./messageTime";

describe("formatMessageTime", () => {
  it("epoch ミリ秒をローカルの HH:MM（24h・ゼロ埋め）に整形する", () => {
    const epochMs = Date.UTC(2024, 0, 1, 9, 5, 0);
    const d = new Date(epochMs);
    const expected = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(formatMessageTime(epochMs)).toBe(expected);
  });

  it("時・分をゼロ埋めする（1 桁の時・分）", () => {
    // ローカルの真夜中を基準に 0:00 を作り、ゼロ埋め（"00:00" 形式）を検証する。
    const local = new Date(2024, 5, 15, 0, 0, 0, 0);
    const result = formatMessageTime(local.getTime());
    expect(result).toMatch(/^\d{2}:\d{2}$/);
    expect(result.length).toBe(5);
  });

  it("結果は常に HH:MM（5 文字・コロン区切り）の形になる", () => {
    const result = formatMessageTime(Date.now());
    expect(result).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });

  it("NaN には空文字列を返す", () => {
    expect(formatMessageTime(Number.NaN)).toBe("");
  });

  it("Infinity には空文字列を返す", () => {
    expect(formatMessageTime(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatMessageTime(Number.NEGATIVE_INFINITY)).toBe("");
  });

  it("非数値（型外の値）には空文字列を返す", () => {
    expect(formatMessageTime("123" as unknown as number)).toBe("");
    expect(formatMessageTime(undefined as unknown as number)).toBe("");
    expect(formatMessageTime(null as unknown as number)).toBe("");
  });

  it("エポック 0（1970-01-01）でも有効な HH:MM を返す（空文字ではない）", () => {
    expect(formatMessageTime(0)).toMatch(/^\d{2}:\d{2}$/);
  });
});

import { formatMessageDate } from "./messageTime";

describe("formatMessageDate", () => {
  it("epoch ミリ秒をローカルの YYYY年M月D日（曜）に整形する", () => {
    // ローカルタイムで日付要素を組み立て、TZ に関わらず安定した期待値にする。
    const local = new Date(2026, 6, 21, 10, 30, 0, 0); // 2026-07-21
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const expected = `2026年7月21日（${weekdays[local.getDay()]}）`;
    expect(formatMessageDate(local.getTime())).toBe(expected);
  });

  it("既知の日付で曜日 1 文字が正しい（2026-07-21 は火曜）", () => {
    // 2026-07-21 は火曜日。ローカル正午基準で TZ ずれによる日付跨ぎを避ける。
    const local = new Date(2026, 6, 21, 12, 0, 0, 0);
    expect(formatMessageDate(local.getTime())).toBe("2026年7月21日（火）");
  });

  it("月・日はゼロ埋めしない", () => {
    const local = new Date(2024, 0, 5, 12, 0, 0, 0); // 2024-01-05
    expect(formatMessageDate(local.getTime())).toBe("2024年1月5日（金）");
  });

  it("NaN には空文字列を返す", () => {
    expect(formatMessageDate(Number.NaN)).toBe("");
  });

  it("Infinity には空文字列を返す", () => {
    expect(formatMessageDate(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatMessageDate(Number.NEGATIVE_INFINITY)).toBe("");
  });

  it("非数値（型外の値）には空文字列を返す", () => {
    expect(formatMessageDate("123" as unknown as number)).toBe("");
    expect(formatMessageDate(undefined as unknown as number)).toBe("");
    expect(formatMessageDate(null as unknown as number)).toBe("");
  });
});
