import { describe, expect, it } from "vitest";

import { lazy } from "./manifest.js";
import { isNoun, type NounGroups, resolveNoun } from "./router.js";

const meta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: null,
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "s",
  usage: "u",
} as const;
const groups: NounGroups = {
  doctor: {
    "": lazy({ load: () => Promise.resolve(() => 0), meta }),
    run: lazy({ load: () => Promise.resolve(() => 0), meta }),
  },
  // A noun with named verbs but NO default handler.
  plain: {
    go: lazy({ load: () => Promise.resolve(() => 0), meta }),
  },
};

const argv = (...rest: string[]): readonly string[] => ["node", "cli", ...rest];

describe("resolveNoun", () => {
  it("resolves a named verb to a manifest route", () => {
    const route = resolveNoun({ argv: argv("doctor", "run"), groups })!;
    expect(route.kind).toBe("manifest");
    expect(route.verb).toBe("run");
  });

  it("resolves a bare noun to its default verb", () => {
    const route = resolveNoun({ argv: argv("doctor"), groups })!;
    expect(route.verb).toBe("");
  });

  it("treats a flag after the noun as the default-verb tail", () => {
    const route = resolveNoun({ argv: argv("doctor", "--json"), groups })!;
    expect(route.verb).toBe("");
  });

  it("returns null for an unknown noun", () => {
    expect(resolveNoun({ argv: argv("nope"), groups })).toBeNull();
  });

  it("routes an unknown verb to the default handler when the noun has one (free-text tail)", () => {
    const route = resolveNoun({ argv: argv("doctor", "nope"), groups })!;
    expect(route.verb).toBe("");
  });

  it("returns null for an unknown verb under a noun with no default", () => {
    expect(resolveNoun({ argv: argv("plain", "nope"), groups })).toBeNull();
  });
});

describe("isNoun", () => {
  it("is true for a registered noun even with no verb", () => {
    expect(isNoun({ argv: argv("doctor"), groups })).toBe(true);
  });

  it("is false for an unregistered noun", () => {
    expect(isNoun({ argv: argv("nope"), groups })).toBe(false);
  });
});
