import { describe, expect, it } from "vitest";
import {
  hydrateOneSourceStructures,
  type StructureHydrationResult,
  summariseStructureHydration,
} from "./structures.js";

const AT = "2026-07-20T00:00:00.000Z";

describe("hydrateOneSourceStructures (no-op routing — no network)", () => {
  it("returns undefined for github when NOT in org mode (no github selection)", async () => {
    const result = await hydrateOneSourceStructures({
      fetchedAtIso: AT,
      home: "/tmp/x",
      source: "github",
      tokens: { github: "t" },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a source with no token", async () => {
    const result = await hydrateOneSourceStructures({ fetchedAtIso: AT, home: "/tmp/x", source: "slack", tokens: {} });
    expect(result).toBeUndefined();
  });

  it("returns undefined for the synthetic gold source", async () => {
    const result = await hydrateOneSourceStructures({ fetchedAtIso: AT, home: "/tmp/x", source: "gold", tokens: {} });
    expect(result).toBeUndefined();
  });
});

describe("summariseStructureHydration", () => {
  it("emits an OUT line for a success and WARN lines for warnings", () => {
    const results: StructureHydrationResult[] = [
      { deduped: 3, errors: [], hydrated: 5, ok: true, source: "github", warnings: ["teams unavailable"], written: 2 },
    ];
    expect(summariseStructureHydration({ results })).toEqual([
      { level: "warn", text: "  structures github: teams unavailable" },
      { level: "out", text: "structures github: hydrated 5 (wrote 2 new, deduped 3)" },
    ]);
  });

  it("emits a WARN (never error) for a failed source — structure hydration never fails the verb", () => {
    const results: StructureHydrationResult[] = [
      { deduped: 0, errors: ["boom"], hydrated: 0, ok: false, source: "linear", warnings: [], written: 0 },
    ];
    expect(summariseStructureHydration({ results })).toEqual([{ level: "warn", text: "  structures linear: boom" }]);
  });
});
