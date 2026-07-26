import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../relativeTime";

describe("formatRelativeTime", () => {
  const now = new Date("2025-07-10T12:00:00.000Z");

  it("1分未満は「今」を返す", () => {
    const timestamp = new Date("2025-07-10T11:59:30.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("今");
  });

  it("ちょうど0秒差は「今」を返す", () => {
    const timestamp = now.toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("今");
  });

  it("1時間未満は「N分前」を返す", () => {
    const timestamp = new Date("2025-07-10T11:45:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("15分前");
  });

  it("1分ちょうどは「1分前」を返す", () => {
    const timestamp = new Date("2025-07-10T11:59:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("1分前");
  });

  it("24時間未満は「N時間前」を返す", () => {
    const timestamp = new Date("2025-07-10T09:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("3時間前");
  });

  it("1時間ちょうどは「1時間前」を返す", () => {
    const timestamp = new Date("2025-07-10T11:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("1時間前");
  });

  it("24〜48時間は「昨日」を返す", () => {
    const timestamp = new Date("2025-07-09T10:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("昨日");
  });

  it("48時間〜7日は「N日前」を返す", () => {
    const timestamp = new Date("2025-07-07T12:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("3日前");
  });

  it("7日ちょうどは「7日前」を返す", () => {
    const timestamp = new Date("2025-07-03T12:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("7日前");
  });

  it("7日超は日付文字列を返す", () => {
    const timestamp = new Date("2025-01-15T10:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("2025/01/15");
  });

  it("未来のタイムスタンプは日付文字列を返す", () => {
    const timestamp = new Date("2025-07-11T12:00:00.000Z").toISOString();
    expect(formatRelativeTime(timestamp, now)).toBe("2025/07/11");
  });

  it("now を省略すると現在時刻を基準にする", () => {
    const result = formatRelativeTime(new Date().toISOString());
    expect(result).toBe("今");
  });
});
