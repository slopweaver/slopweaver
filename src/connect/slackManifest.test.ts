import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecord } from "../lib/parsers.js";
import { SLACK_REQUIRED_USER_SCOPES } from "./slack.js";

/** Load a bundled Slack app manifest by filename. */
function loadManifest({ file }: { file: string }): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../templates/${file}`, import.meta.url)), "utf8"));
}

/** The `oauth_config.scopes` record of a manifest (empty when the shape is unexpected — the test fails loud). */
function scopesOf({ file }: { file: string }): Record<string, unknown> {
  const manifest = loadManifest({ file });
  if (isRecord(manifest) && isRecord(manifest["oauth_config"]) && isRecord(manifest["oauth_config"]["scopes"])) {
    return manifest["oauth_config"]["scopes"];
  }
  return {};
}

/** A manifest's `user` scope list (empty when absent/malformed). */
function userScopes({ file }: { file: string }): readonly string[] {
  const user = scopesOf({ file })["user"];
  return Array.isArray(user) ? user.filter((s): s is string => typeof s === "string") : [];
}

/** A manifest's `bot` scope list (empty when absent/malformed). */
function botScopes({ file }: { file: string }): readonly string[] {
  const bot = scopesOf({ file })["bot"];
  return Array.isArray(bot) ? bot.filter((s): s is string => typeof s === "string") : [];
}

const READONLY = "slack-app-manifest.readonly.json";
const FULL = "slack-app-manifest.full.json";

describe("read-only Slack manifest", () => {
  it("declares EXACTLY the user scopes the ingest lanes require", () => {
    expect([...userScopes({ file: READONLY })].toSorted()).toEqual([...SLACK_REQUIRED_USER_SCOPES].toSorted());
  });

  it("requests no write scopes and no bot scopes (lowest-risk footprint)", () => {
    expect(userScopes({ file: READONLY }).filter((s) => s.includes(":write"))).toEqual([]);
    expect(Object.keys(scopesOf({ file: READONLY }))).toEqual(["user"]);
  });
});

describe("full Slack manifest", () => {
  it("is a SUPERSET of the read-only ingest scopes (so ingest works unchanged)", () => {
    const user = new Set(userScopes({ file: FULL }));
    for (const scope of SLACK_REQUIRED_USER_SCOPES) {
      expect(user.has(scope)).toBe(true);
    }
  });

  it("adds write scopes + a bot section for parity with the operating assistant", () => {
    expect(userScopes({ file: FULL }).filter((s) => s.includes(":write")).length).toBeGreaterThan(0);
    expect(botScopes({ file: FULL })).toContain("chat:write");
  });

  it("carries users:read.email on both the user and bot tokens (cross-source member linking)", () => {
    expect(userScopes({ file: FULL })).toContain("users:read.email");
    expect(botScopes({ file: FULL })).toContain("users:read.email");
  });
});
