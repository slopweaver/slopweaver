import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../../init/stateInit.js";
import { stateHomePaths } from "../../../stateHome.js";
import { doctorJsonReport, doctorReport } from "./run.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slop-doctor-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

describe("doctorReport", () => {
  it("reports an initialised home: version, corpus roots, valid seeds", () => {
    runInit({ home });
    const lines = doctorReport({ envHome: home, home, version: "9.9.9" });
    expect(lines[0]).toBe("slopweaver v9.9.9");
    expect(lines).toContain(`SLOPWEAVER_HOME: ${home}`);
    expect(lines).toContain("home version: 1");
    expect(lines).toContain("corpus: bronze exists (empty) · silver exists (empty) · gold exists (empty)");
    expect(lines).toContain("identity.json: present (valid)");
    expect(lines).toContain("profile.json: present (valid)");
    expect(lines).toContain("hygiene-denylist.txt: present");
    expect(lines[lines.length - 1]).toBe("ok");
  });

  it("reports an uninitialised home as not-initialised, pointing at init", () => {
    const lines = doctorReport({ envHome: undefined, home, version: "9.9.9" });
    expect(lines).toContain("home version: not initialised — run `slopweaver init`");
    expect(lines).toContain("corpus: bronze missing · silver missing · gold missing");
    expect(lines).toContain("profile.json: missing — run `slopweaver init`");
    expect(lines).toContain(`SLOPWEAVER_HOME: unset — using default ${home}`);
  });

  it("is read-only — reporting creates nothing", () => {
    doctorReport({ envHome: home, home, version: "9.9.9" });
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("doctorJsonReport", () => {
  it("reports a stable, structured shape for an initialised home", () => {
    runInit({ home });
    const report = doctorJsonReport({ envHome: home, home, version: "9.9.9" });
    expect(report.version).toBe("9.9.9");
    expect(report.home).toBe(home);
    expect(report.initialised).toBe(true);
    expect(report.statuses["identity"]).toBe("present-valid");
    expect(report.statuses["profile"]).toBe("present-valid");
    expect(report.statuses["secrets"]).toBe("exists (empty)");
    expect(report.paths["secrets"]).toBe(stateHomePaths({ home }).secrets);
  });

  it("reports an uninitialised home as not initialised, with missing seeds", () => {
    const report = doctorJsonReport({ envHome: undefined, home, version: "9.9.9" });
    expect(report.initialised).toBe(false);
    expect(report.envHome).toBe(null);
    expect(report.statuses["identity"]).toBe("missing");
    expect(report.statuses["bronze"]).toBe("missing");
  });

  it("never emits identity or profile CONTENTS — only a parse status", () => {
    runInit({ home });
    const p = stateHomePaths({ home });
    writeFileSync(p.profileJson, JSON.stringify({ displayName: "SENSITIVE-NAME", id: "x" }), "utf8");
    const serialised = JSON.stringify(doctorJsonReport({ envHome: home, home, version: "9.9.9" }));
    expect(serialised).not.toContain("SENSITIVE-NAME");
  });
});
