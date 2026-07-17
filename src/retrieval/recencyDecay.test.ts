import { describe, expect, it } from "vitest";
import { decayParamsFromDays, decayWeight, recordDecayWeight, tsIsoToMs } from "./recencyDecay.js";

const DAY = 86_400_000;

describe("decayWeight", () => {
  it("is 1 at now and ~0.5 one half-life ago", () => {
    expect(decayWeight({ halfLifeMs: 7 * DAY, nowMs: 1000, tsMs: 1000 })).toBe(1);
    expect(decayWeight({ halfLifeMs: 7 * DAY, nowMs: 7 * DAY, tsMs: 0 })).toBeCloseTo(0.5, 5);
  });

  it("clamps a future timestamp to 1", () => {
    expect(decayWeight({ halfLifeMs: 7 * DAY, nowMs: 1000, tsMs: 2000 })).toBe(1);
  });
});

describe("recordDecayWeight", () => {
  it("floors a missing timestamp just above 0 rather than dropping it", () => {
    expect(recordDecayWeight({ nowMs: 1000, tsMs: undefined })).toBeGreaterThan(0);
    expect(recordDecayWeight({ nowMs: 1000, tsMs: undefined })).toBeLessThan(0.001);
  });
});

describe("tsIsoToMs", () => {
  it("parses an ISO string and rejects garbage", () => {
    expect(tsIsoToMs({ tsIso: "2024-01-01T00:00:00Z" })).toBe(Date.parse("2024-01-01T00:00:00Z"));
    expect(tsIsoToMs({ tsIso: "nope" })).toBeUndefined();
  });
});

describe("decayParamsFromDays", () => {
  it("converts days to a half-life, else uses the default", () => {
    expect(decayParamsFromDays({ days: 3, nowMs: 10 })).toEqual({ halfLifeMs: 3 * DAY, nowMs: 10 });
    expect(decayParamsFromDays({ days: undefined, nowMs: 10 })).toEqual({ nowMs: 10 });
  });
});
