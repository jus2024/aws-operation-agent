/**
 * computeStickyDateState のユニットテスト
 *
 * DOM 非依存の純粋ロジックとして、「区切り行の相対 top 並び + ヘッダー高さ」から
 * 浮遊日付ヘッダーの表示状態（可視 / ラベル / 押し上げ）を算出する分岐を検証する。
 */

import { describe, it, expect } from "vitest";
import { computeStickyDateState, type DividerPosition } from "./stickyDate";

const HEADER_H = 40;

describe("computeStickyDateState", () => {
  it("区切り行が無い（dated メッセージ 0 件）ときは非表示", () => {
    expect(computeStickyDateState([], HEADER_H)).toEqual({
      visible: false,
      label: "",
      translateY: 0,
    });
  });

  it("会話の先頭付近（最初の区切りがまだ上端より下）では非表示", () => {
    const dividers: DividerPosition[] = [
      { label: "Day1", top: 120 },
      { label: "Day2", top: 640 },
    ];
    expect(computeStickyDateState(dividers, HEADER_H)).toEqual({
      visible: false,
      label: "",
      translateY: 0,
    });
  });

  it("最初の区切りが上端に到達したらその日をピン留めする", () => {
    const dividers: DividerPosition[] = [
      { label: "Day1", top: 0 },
      { label: "Day2", top: 500 },
    ];
    expect(computeStickyDateState(dividers, HEADER_H)).toEqual({
      visible: true,
      label: "Day1",
      translateY: 0,
    });
  });

  it("上端を通り過ぎた最後（最も下）の区切りの日をアクティブにする", () => {
    const dividers: DividerPosition[] = [
      { label: "Day1", top: -800 },
      { label: "Day2", top: -120 },
      { label: "Day3", top: 500 },
    ];
    const state = computeStickyDateState(dividers, HEADER_H);
    expect(state.visible).toBe(true);
    expect(state.label).toBe("Day2");
    expect(state.translateY).toBe(0);
  });

  it("次の日の区切りがヘッダー高さ以内に近づくと現在ヘッダーを押し上げる", () => {
    // Day2 が top=10（0 < 10 < 40）まで来た → translateY = 10 - 40 = -30
    const dividers: DividerPosition[] = [
      { label: "Day1", top: -300 },
      { label: "Day2", top: 10 },
    ];
    const state = computeStickyDateState(dividers, HEADER_H);
    expect(state.visible).toBe(true);
    expect(state.label).toBe("Day1");
    expect(state.translateY).toBe(-30);
  });

  it("次の日の区切りがヘッダー高さより遠いときは押し上げない", () => {
    const dividers: DividerPosition[] = [
      { label: "Day1", top: -300 },
      { label: "Day2", top: 200 },
    ];
    const state = computeStickyDateState(dividers, HEADER_H);
    expect(state.translateY).toBe(0);
  });

  it("単一の暦日: 通過後はその日を表示し、押し上げは発生しない", () => {
    const dividers: DividerPosition[] = [{ label: "OnlyDay", top: -50 }];
    expect(computeStickyDateState(dividers, HEADER_H)).toEqual({
      visible: true,
      label: "OnlyDay",
      translateY: 0,
    });
  });

  it("しきい値付近（top がわずかに正）でも上端到達とみなす", () => {
    const dividers: DividerPosition[] = [{ label: "Day1", top: 0.4 }];
    expect(computeStickyDateState(dividers, HEADER_H).visible).toBe(true);
  });

  it("headerHeight が 0/無効のときは押し上げず表示のみ行う", () => {
    const dividers: DividerPosition[] = [
      { label: "Day1", top: -100 },
      { label: "Day2", top: 5 },
    ];
    expect(computeStickyDateState(dividers, 0).translateY).toBe(0);
    expect(computeStickyDateState(dividers, Number.NaN).translateY).toBe(0);
  });
});
