import { describe, expect, it } from "vitest";
import { composeLint, lintChecks } from "./devLint.js";

describe("composeLint", () => {
  it("passes (exit 0) only when every check passed", () => {
    const { ok, exit } = composeLint({
      results: [
        { name: "biome", ok: true },
        { name: "eslint", ok: true },
      ],
    });
    expect(ok).toBe(true);
    expect(exit).toBe(0);
  });

  it("fails (exit 1) when any check failed", () => {
    const { ok, exit } = composeLint({
      results: [
        { name: "biome", ok: true },
        { name: "eslint", ok: false },
      ],
    });
    expect(ok).toBe(false);
    expect(exit).toBe(1);
  });

  it("passes vacuously on no checks", () => {
    expect(composeLint({ results: [] })).toEqual({ exit: 0, ok: true });
  });
});

describe("lintChecks", () => {
  it("plans every check in run order, resolving local bins under the cwd", () => {
    const checks = lintChecks({ cwd: "/repo" });
    expect(checks.map((c) => c.name)).toEqual([
      "biome",
      "prettier",
      "oxlint",
      "eslint",
      "knip",
      "constraints",
      "hygiene",
      "resilience-residue",
      "boundary-residue",
      "max-function-lines",
      "door-coverage",
    ]);
    expect(checks.find((c) => c.name === "eslint")!.cmd).toBe("/repo/node_modules/.bin/eslint");
    // Every linter escalates warnings to failures — no ignorable middle ground.
    expect(checks.find((c) => c.name === "biome")!.args).toEqual(["check", "--error-on-warnings", "."]);
    expect(checks.find((c) => c.name === "eslint")!.args).toEqual([".", "--max-warnings", "0"]);
    expect(checks.find((c) => c.name === "oxlint")!.args).toEqual(["--deny-warnings"]);
  });

  it("runs constraints via yarn and hygiene via bash (not local bins)", () => {
    const checks = lintChecks({ cwd: "/repo" });
    expect(checks.find((c) => c.name === "constraints")!.cmd).toBe("yarn");
    expect(checks.find((c) => c.name === "hygiene")!.cmd).toBe("bash");
  });
});
