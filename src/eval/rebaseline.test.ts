import { describe, expect, it } from "vitest";
import { unwrap, unwrapErr } from "../lib/result.js";
import { decideRebaseline } from "./rebaselineCore.js";

describe("decideRebaseline authorisation", () => {
  it("refuses without --write", () => {
    const result = decideRebaseline({ allowInCi: false, args: ["--reason", "x"], ci: false });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("pass --write");
  });

  it("refuses --write without a --reason", () => {
    const result = decideRebaseline({ allowInCi: false, args: ["--write"], ci: false });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("pass --reason");
  });

  it("refuses a --reason that is just another flag", () => {
    const result = decideRebaseline({ allowInCi: false, args: ["--write", "--reason", "--write"], ci: false });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("pass --reason");
  });

  it("authorises with --write and a non-empty --reason", () => {
    const result = decideRebaseline({
      allowInCi: false,
      args: ["--write", "--reason", "tuned decay half-life"],
      ci: false,
    });
    expect(result.ok).toBe(true);
    expect(unwrap(result).reason).toBe("tuned decay half-life");
  });

  it("refuses in CI without the explicit override", () => {
    const result = decideRebaseline({ allowInCi: false, args: ["--write", "--reason", "x"], ci: true });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result).join(" ")).toContain("CI");
  });

  it("allows CI only with the explicit override", () => {
    const result = decideRebaseline({ allowInCi: true, args: ["--write", "--reason", "x"], ci: true });
    expect(result.ok).toBe(true);
    expect(unwrap(result).reason).toBe("x");
  });
});
