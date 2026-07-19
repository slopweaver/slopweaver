import { describe, expect, it } from "vitest";
import {
  parseIsoMs,
  parseYyyyMmDdUtcMs,
  yyyyMmDdMinusDays,
  yyyyMmDdTodayPlus,
  yyyyMmDdToEpochSeconds,
} from "./date.js";

const FIXED_NOW = new Date("2026-07-19T13:45:00Z");

describe("yyyyMmDdTodayPlus", () => {
  it("returns today for a zero offset", () => {
    expect(yyyyMmDdTodayPlus({ days: 0, now: FIXED_NOW })).toBe("2026-07-19");
  });

  it("adds days", () => {
    expect(yyyyMmDdTodayPlus({ days: 1, now: FIXED_NOW })).toBe("2026-07-20");
  });

  it("subtracts days for a negative offset", () => {
    expect(yyyyMmDdTodayPlus({ days: -1, now: FIXED_NOW })).toBe("2026-07-18");
  });

  it("does not mutate the injected date", () => {
    yyyyMmDdTodayPlus({ days: 30, now: FIXED_NOW });
    expect(FIXED_NOW.toISOString()).toBe("2026-07-19T13:45:00.000Z");
  });
});

describe("yyyyMmDdMinusDays", () => {
  it("crosses a month boundary", () => {
    expect(yyyyMmDdMinusDays({ date: "2026-03-01", days: 1 })).toBe("2026-02-28");
  });

  it("crosses a year boundary", () => {
    expect(yyyyMmDdMinusDays({ date: "2026-01-01", days: 1 })).toBe("2025-12-31");
  });
});

describe("parseYyyyMmDdUtcMs", () => {
  it("returns UTC-midnight ms for a valid date", () => {
    expect(parseYyyyMmDdUtcMs({ date: "1970-01-02" })).toBe(86_400_000);
  });

  it("returns undefined for an unparseable date", () => {
    expect(parseYyyyMmDdUtcMs({ date: "not-a-date" })).toBeUndefined();
  });
});

describe("yyyyMmDdToEpochSeconds", () => {
  it("returns floored epoch seconds at UTC midnight", () => {
    expect(yyyyMmDdToEpochSeconds({ date: "1970-01-02" })).toBe(86_400);
  });

  it("returns undefined for an unparseable date", () => {
    expect(yyyyMmDdToEpochSeconds({ date: "xyz" })).toBeUndefined();
  });
});

describe("parseIsoMs", () => {
  it("returns ms for a valid ISO timestamp", () => {
    expect(parseIsoMs({ tsIso: "1970-01-01T00:00:01.000Z" })).toBe(1000);
  });

  it("returns undefined for an invalid timestamp", () => {
    expect(parseIsoMs({ tsIso: "nonsense" })).toBeUndefined();
  });
});
