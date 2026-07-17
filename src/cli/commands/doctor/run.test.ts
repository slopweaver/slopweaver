import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../../init/stateInit.js";
import { doctorReport } from "./run.js";

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
